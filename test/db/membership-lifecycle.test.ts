import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/server.js";
import { closeDb, getDb } from "@/lib/db/index.js";
import { communityMembers, participants } from "@/lib/db/schema/index.js";
import { resetDb } from "../helpers/db.js";
import { TEST_SERVICE_TOKEN } from "../constants.js";

let app: FastifyInstance;

function post(url: string, body: unknown, options: { token?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== false) {
    headers["x-service-token"] = TEST_SERVICE_TOKEN;
    headers["x-service-name"] = "test-bot";
  }
  return app.inject({ method: "POST", url, headers, payload: JSON.stringify(body) });
}

const ensure = (body: unknown, options?: { token?: boolean }) =>
  post("/api/v1/memberships/ensure", body, options);
const leave = (body: unknown, options?: { token?: boolean }) =>
  post("/api/v1/memberships/leave", body, options);
const resolveParticipant = (body: unknown) => post("/api/v1/participants/resolve", body);
const resolveCommunity = (body: unknown) => post("/api/v1/communities/resolve", body);
const claim = (body: unknown) => post("/api/v1/participants/claim", body);

async function countParticipants(): Promise<number> {
  return (await getDb().select().from(participants)).length;
}

async function membershipsFor(participantId: string) {
  return getDb()
    .select()
    .from(communityMembers)
    .where(eq(communityMembers.participantId, participantId));
}

async function membershipFor(communityId: string, participantId: string) {
  const rows = await getDb()
    .select()
    .from(communityMembers)
    .where(
      and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.participantId, participantId),
      ),
    );
  return rows[0];
}

async function allMemberships() {
  return getDb().select().from(communityMembers);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

describe("POST /api/v1/memberships/ensure", () => {
  it("creates a membership (active, permission level 0) on first call, and is idempotent", async () => {
    const first = await ensure({
      platform: "discord",
      platformUserId: "u-1",
      platformGroupId: "g-1",
      communityName: "Guild One",
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.success).toBe(true);
    expect(firstBody.data.created).toBe(true);
    expect(firstBody.data.reactivated).toBe(false);
    expect(firstBody.data.membership.active).toBe(true);
    expect(firstBody.data.membership.permissionLevel).toBe(0);
    expect(firstBody.data.membership.leftAt).toBeNull();
    expect(firstBody.data.participant.noclulabsIdentityId).toBeNull();
    expect(firstBody.data.community.name).toBe("Guild One");
    const membershipId = firstBody.data.membership.id as string;
    const communityId = firstBody.data.community.id as string;
    const participantId = firstBody.data.participant.id as string;
    const before = await membershipFor(communityId, participantId);

    const second = await ensure({
      platform: "discord",
      platformUserId: "u-1",
      platformGroupId: "g-1",
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    // Idempotent: same row, no create, no reactivate, no duplicate.
    expect(secondBody.data.created).toBe(false);
    expect(secondBody.data.reactivated).toBe(false);
    expect(secondBody.data.membership.id).toBe(membershipId);
    expect((await allMemberships()).length).toBe(1);
    // The active no-op performed no write, so the set_updated_at trigger never
    // fired and updated_at is unchanged.
    const after = await membershipFor(communityId, participantId);
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("reactivates the same row on rejoin, preserving created_at and permission_level", async () => {
    const created = await ensure({
      platform: "discord",
      platformUserId: "u-rejoin",
      platformGroupId: "g-rejoin",
    });
    const communityId = created.json().data.community.id as string;
    const participantId = created.json().data.participant.id as string;
    const original = await membershipFor(communityId, participantId);
    expect(original).toBeDefined();

    // Simulate a moderation grant: a non-default permission level that the rejoin
    // must preserve (the routes default it to 0 and do not change it).
    await getDb()
      .update(communityMembers)
      .set({ permissionLevel: 3 })
      .where(eq(communityMembers.id, original!.id));

    const left = await leave({
      platform: "discord",
      platformUserId: "u-rejoin",
      platformGroupId: "g-rejoin",
    });
    expect(left.json().data.left).toBe(true);
    expect(left.json().data.membership.active).toBe(false);
    expect(left.json().data.membership.leftAt).not.toBeNull();

    const rejoined = await ensure({
      platform: "discord",
      platformUserId: "u-rejoin",
      platformGroupId: "g-rejoin",
    });
    const body = rejoined.json();
    expect(body.data.created).toBe(false);
    expect(body.data.reactivated).toBe(true);
    expect(body.data.membership.id).toBe(original!.id);
    expect(body.data.membership.active).toBe(true);
    expect(body.data.membership.leftAt).toBeNull();
    expect(body.data.membership.permissionLevel).toBe(3);
    // created_at is unchanged across the leave and rejoin.
    const after = await membershipFor(communityId, participantId);
    expect(after!.createdAt.getTime()).toBe(original!.createdAt.getTime());
    expect((await allMemberships()).length).toBe(1);
  });

  it("returns 400 for a platform absent from the registry", async () => {
    const response = await ensure({
      platform: "telegram",
      platformUserId: "u-x",
      platformGroupId: "g-x",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);
  });

  it("returns 401 when the service token is missing", async () => {
    const response = await ensure(
      { platform: "discord", platformUserId: "u-x", platformGroupId: "g-x" },
      { token: false },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  // Concurrency: two simultaneous first-time ensures of the same (community,
  // participant) converge to one membership via the unique key and retry.
  it("converges two simultaneous ensures of the same membership to one row", async () => {
    const [a, b] = await Promise.all([
      ensure({ platform: "discord", platformUserId: "u-race", platformGroupId: "g-race" }),
      ensure({ platform: "discord", platformUserId: "u-race", platformGroupId: "g-race" }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const bodyA = a.json();
    const bodyB = b.json();
    // Same participant, same community, same membership row.
    expect(bodyA.data.participant.id).toBe(bodyB.data.participant.id);
    expect(bodyA.data.community.id).toBe(bodyB.data.community.id);
    expect(bodyA.data.membership.id).toBe(bodyB.data.membership.id);
    // Exactly one of the two calls created the row.
    expect([bodyA.data.created, bodyB.data.created].filter(Boolean)).toHaveLength(1);
    expect(await countParticipants()).toBe(1);
    expect((await allMemberships()).length).toBe(1);
  });
});

describe("POST /api/v1/memberships/leave", () => {
  it("marks an active membership inactive and sets left_at", async () => {
    const created = await ensure({
      platform: "discord",
      platformUserId: "u-leave",
      platformGroupId: "g-leave",
    });
    const communityId = created.json().data.community.id as string;
    const participantId = created.json().data.participant.id as string;

    const response = await leave({
      platform: "discord",
      platformUserId: "u-leave",
      platformGroupId: "g-leave",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.left).toBe(true);
    expect(body.data.membership.active).toBe(false);
    expect(body.data.membership.leftAt).not.toBeNull();

    const row = await membershipFor(communityId, participantId);
    expect(row!.active).toBe(false);
    expect(row!.leftAt).not.toBeNull();
  });

  it("is an idempotent no-op when the membership is already inactive", async () => {
    await ensure({ platform: "discord", platformUserId: "u-twice", platformGroupId: "g-twice" });
    const firstLeave = await leave({
      platform: "discord",
      platformUserId: "u-twice",
      platformGroupId: "g-twice",
    });
    expect(firstLeave.json().data.left).toBe(true);

    const secondLeave = await leave({
      platform: "discord",
      platformUserId: "u-twice",
      platformGroupId: "g-twice",
    });
    expect(secondLeave.statusCode).toBe(200);
    const body = secondLeave.json();
    expect(body.data.left).toBe(false);
    expect(body.data.membership.active).toBe(false);
  });

  it("is an idempotent no-op success when there is nothing to leave", async () => {
    // Never resolved: no participant, no community, no membership.
    const noParticipant = await leave({
      platform: "discord",
      platformUserId: "ghost-user",
      platformGroupId: "ghost-group",
    });
    expect(noParticipant.statusCode).toBe(200);
    expect(noParticipant.json().success).toBe(true);
    expect(noParticipant.json().data.left).toBe(false);
    expect(noParticipant.json().data.membership).toBeNull();

    // The participant exists but was never a member of this community.
    await resolveParticipant({ platform: "discord", platformUserId: "u-known" });
    await resolveCommunity({ platform: "discord", platformGroupId: "g-known" });
    const noMembership = await leave({
      platform: "discord",
      platformUserId: "u-known",
      platformGroupId: "g-known",
    });
    expect(noMembership.statusCode).toBe(200);
    expect(noMembership.json().data.left).toBe(false);
    expect(noMembership.json().data.membership).toBeNull();
  });
});

describe("merge relocation of community_members", () => {
  // Set up a survivor that holds an identity and a separate ghost, then claim the
  // ghost's account to the same identity to drive the merge.
  async function setupSurvivorAndGhost() {
    const identity = randomUUID();
    const survivorClaim = await claim({
      platform: "discord",
      platformUserId: "s-acct",
      noclulabsIdentityId: identity,
    });
    const survivorId = survivorClaim.json().data.participant.id as string;

    const ghostResolve = await resolveParticipant({ platform: "discord", platformUserId: "p-acct" });
    const ghostId = ghostResolve.json().data.participant.id as string;
    expect(ghostId).not.toBe(survivorId);

    return { identity, survivorId, ghostId };
  }

  function mergeGhost(identity: string) {
    return claim({ platform: "discord", platformUserId: "p-acct", noclulabsIdentityId: identity });
  }

  it("re-points a membership when the survivor is not a member of that community", async () => {
    const { identity, survivorId, ghostId } = await setupSurvivorAndGhost();
    const community = await resolveCommunity({ platform: "discord", platformGroupId: "g-repoint" });
    const communityId = community.json().data.community.id as string;

    const createdAt = new Date("2021-03-04T05:06:07.000Z");
    const ghostMembership = (
      await getDb()
        .insert(communityMembers)
        .values({ communityId, participantId: ghostId, permissionLevel: 3, active: true, createdAt })
        .returning()
    )[0];

    const response = await mergeGhost(identity);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("merged");

    // The membership now belongs to the survivor; the same row was re-pointed
    // (its id, created_at, and permission_level are preserved).
    const survivorMembership = await membershipFor(communityId, survivorId);
    expect(survivorMembership).toBeDefined();
    expect(survivorMembership!.id).toBe(ghostMembership!.id);
    expect(survivorMembership!.permissionLevel).toBe(3);
    expect(survivorMembership!.active).toBe(true);
    expect(survivorMembership!.createdAt.getTime()).toBe(createdAt.getTime());
    // The ghost is gone and owns no membership; the guard had nothing to trip on.
    expect(await countParticipants()).toBe(1);
    expect((await membershipsFor(ghostId)).length).toBe(0);
    expect((await allMemberships()).length).toBe(1);
  });

  it("combines into the survivor's row when both are members (active if either)", async () => {
    const { identity, survivorId, ghostId } = await setupSurvivorAndGhost();
    const community = await resolveCommunity({ platform: "discord", platformGroupId: "g-combine" });
    const communityId = community.json().data.community.id as string;

    const survivorCreatedAt = new Date("2020-01-01T00:00:00.000Z");
    const survivorMembershipBefore = (
      await getDb()
        .insert(communityMembers)
        .values({
          communityId,
          participantId: survivorId,
          permissionLevel: 2,
          active: false,
          leftAt: new Date("2022-01-01T00:00:00.000Z"),
          createdAt: survivorCreatedAt,
        })
        .returning()
    )[0];
    await getDb().insert(communityMembers).values({
      communityId,
      participantId: ghostId,
      permissionLevel: 5,
      active: true,
      leftAt: null,
    });

    const response = await mergeGhost(identity);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("merged");

    // One combined row on the survivor: higher permission level, active because
    // the ghost was, left_at cleared, created_at unchanged, ghost row deleted.
    const rows = await allMemberships();
    expect(rows.length).toBe(1);
    const combined = rows[0];
    expect(combined!.id).toBe(survivorMembershipBefore!.id);
    expect(combined!.participantId).toBe(survivorId);
    expect(combined!.permissionLevel).toBe(5);
    expect(combined!.active).toBe(true);
    expect(combined!.leftAt).toBeNull();
    expect(combined!.createdAt.getTime()).toBe(survivorCreatedAt.getTime());
    expect(await countParticipants()).toBe(1);
    expect((await membershipsFor(ghostId)).length).toBe(0);
  });

  it("combines two inactive memberships, keeping the later left_at", async () => {
    const { identity, survivorId, ghostId } = await setupSurvivorAndGhost();
    const community = await resolveCommunity({ platform: "discord", platformGroupId: "g-combine2" });
    const communityId = community.json().data.community.id as string;

    const earlier = new Date("2021-06-01T00:00:00.000Z");
    const later = new Date("2023-09-15T00:00:00.000Z");
    await getDb().insert(communityMembers).values({
      communityId,
      participantId: survivorId,
      permissionLevel: 1,
      active: false,
      leftAt: earlier,
    });
    await getDb().insert(communityMembers).values({
      communityId,
      participantId: ghostId,
      permissionLevel: 4,
      active: false,
      leftAt: later,
    });

    const response = await mergeGhost(identity);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("merged");

    const rows = await allMemberships();
    expect(rows.length).toBe(1);
    const combined = rows[0];
    expect(combined!.participantId).toBe(survivorId);
    expect(combined!.permissionLevel).toBe(4);
    expect(combined!.active).toBe(false);
    expect(combined!.leftAt!.getTime()).toBe(later.getTime());
    expect((await membershipsFor(ghostId)).length).toBe(0);
  });

  it("relocates both a platform account and a membership, leaving the ghost owning nothing", async () => {
    const { identity, survivorId, ghostId } = await setupSurvivorAndGhost();
    const community = await resolveCommunity({ platform: "discord", platformGroupId: "g-guard" });
    const communityId = community.json().data.community.id as string;
    await getDb()
      .insert(communityMembers)
      .values({ communityId, participantId: ghostId, active: true });

    const response = await mergeGhost(identity);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("merged");

    // The USER_HAS_DATA guard passed because relocation moved every owned row: the
    // membership and the ghost's platform account both sit on the survivor now.
    expect(await countParticipants()).toBe(1);
    expect((await membershipsFor(ghostId)).length).toBe(0);
    const survivorMembership = await membershipFor(communityId, survivorId);
    expect(survivorMembership).toBeDefined();
  });
});
