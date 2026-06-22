import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, or } from "drizzle-orm";
import { buildApp } from "@/server.js";
import { closeDb, getDb, getPool } from "@/lib/db/index.js";
import { communityMembers, moderationActions, participants } from "@/lib/db/schema/index.js";
import { MAX_DURATION_SECONDS } from "@/services/moderation/actions.js";
import { resetDb } from "../helpers/db.js";
import { TEST_SERVICE_TOKEN } from "../constants.js";

let app: FastifyInstance;

function authHeaders(token: boolean): Record<string, string> {
  if (token === false) {
    return {};
  }
  return { "x-service-token": TEST_SERVICE_TOKEN, "x-service-name": "test-bot" };
}

function post(url: string, body: unknown, options: { token?: boolean } = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...authHeaders(options.token ?? true) },
    payload: JSON.stringify(body),
  });
}

function get(url: string, query: Record<string, string>, options: { token?: boolean } = {}) {
  return app.inject({ method: "GET", url, headers: authHeaders(options.token ?? true), query });
}

const moderate = (body: unknown, options?: { token?: boolean }) =>
  post("/api/v1/moderation/actions", body, options);
const stateOf = (query: Record<string, string>, options?: { token?: boolean }) =>
  get("/api/v1/moderation/state", query, options);
const historyOf = (query: Record<string, string>, options?: { token?: boolean }) =>
  get("/api/v1/moderation/history", query, options);
const ensure = (body: unknown) => post("/api/v1/memberships/ensure", body);
const resolveParticipant = (body: unknown) => post("/api/v1/participants/resolve", body);
const resolveCommunity = (body: unknown) => post("/api/v1/communities/resolve", body);
const claim = (body: unknown) => post("/api/v1/participants/claim", body);

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

async function allActions() {
  return getDb().select().from(moderationActions);
}

async function countParticipants(): Promise<number> {
  return (await getDb().select().from(participants)).length;
}

const CLEARED = { muted: false, mutedUntil: null, banned: false, bannedUntil: null };

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

describe("moderation_actions migration", () => {
  it("created an append-only table with no updated_at and no trigger, plus the three indexes", async () => {
    const cols = await getPool().query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'moderation_actions'",
    );
    const names = cols.rows.map((row) => row.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "community_id",
        "actor_participant_id",
        "target_participant_id",
        "action",
        "reason",
        "expires_at",
        "created_at",
      ]),
    );
    // Ledger: content-immutable, so no updated_at column.
    expect(names).not.toContain("updated_at");

    // And therefore no set_updated_at trigger (the FK constraint triggers are
    // internal and excluded).
    const triggers = await getPool().query<{ n: number }>(
      `select count(*)::int as n
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'moderation_actions' and not t.tgisinternal`,
    );
    expect(triggers.rows[0]?.n).toBe(0);

    const idx = await getPool().query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'moderation_actions'",
    );
    expect(idx.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "moderation_actions_target_community_created_idx",
        "moderation_actions_actor_participant_id_idx",
        "moderation_actions_community_created_idx",
      ]),
    );
  });
});

describe("POST /api/v1/moderation/actions effects", () => {
  it("warn appends a log row with no membership effect and no sanction state", async () => {
    const ensured = await ensure({
      platform: "discord",
      platformUserId: "t-warn",
      platformGroupId: "g-warn",
    });
    const communityId = ensured.json().data.community.id as string;
    const targetId = ensured.json().data.participant.id as string;

    const response = await moderate({
      platform: "discord",
      platformGroupId: "g-warn",
      actorPlatformUserId: "mod-1",
      targetPlatformUserId: "t-warn",
      action: "warn",
      reason: "be nice",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.action.action).toBe("warn");
    expect(body.data.action.reason).toBe("be nice");
    expect(body.data.action.expiresAt).toBeNull();
    expect(body.data.sanctionState).toEqual(CLEARED);

    // The membership is untouched, and exactly one row was logged.
    expect((await membershipFor(communityId, targetId))?.active).toBe(true);
    expect((await allActions()).length).toBe(1);
  });

  it("mute sets the muted state and unmute clears it; the membership stays active", async () => {
    const ensured = await ensure({
      platform: "discord",
      platformUserId: "t-mute",
      platformGroupId: "g-mute",
    });
    const communityId = ensured.json().data.community.id as string;
    const targetId = ensured.json().data.participant.id as string;

    const muted = await moderate({
      platform: "discord",
      platformGroupId: "g-mute",
      actorPlatformUserId: "mod",
      targetPlatformUserId: "t-mute",
      action: "mute",
    });
    expect(muted.json().data.sanctionState).toEqual({
      muted: true,
      mutedUntil: null,
      banned: false,
      bannedUntil: null,
    });
    // Mute does not remove the member.
    expect((await membershipFor(communityId, targetId))?.active).toBe(true);

    const unmuted = await moderate({
      platform: "discord",
      platformGroupId: "g-mute",
      actorPlatformUserId: "mod",
      targetPlatformUserId: "t-mute",
      action: "unmute",
    });
    expect(unmuted.json().data.sanctionState.muted).toBe(false);
    expect(unmuted.json().data.sanctionState.mutedUntil).toBeNull();
    expect((await membershipFor(communityId, targetId))?.active).toBe(true);
  });

  it("ban deactivates the membership and sets banned; unban clears it without rejoining", async () => {
    const ensured = await ensure({
      platform: "discord",
      platformUserId: "t-ban",
      platformGroupId: "g-ban",
    });
    const communityId = ensured.json().data.community.id as string;
    const targetId = ensured.json().data.participant.id as string;
    expect((await membershipFor(communityId, targetId))?.active).toBe(true);

    const banned = await moderate({
      platform: "discord",
      platformGroupId: "g-ban",
      actorPlatformUserId: "mod",
      targetPlatformUserId: "t-ban",
      action: "ban",
      reason: "spam",
    });
    expect(banned.json().data.sanctionState.banned).toBe(true);
    expect(banned.json().data.sanctionState.bannedUntil).toBeNull();
    const afterBan = await membershipFor(communityId, targetId);
    expect(afterBan?.active).toBe(false);
    expect(afterBan?.leftAt).not.toBeNull();

    const unbanned = await moderate({
      platform: "discord",
      platformGroupId: "g-ban",
      actorPlatformUserId: "mod",
      targetPlatformUserId: "t-ban",
      action: "unban",
    });
    expect(unbanned.json().data.sanctionState.banned).toBe(false);
    // unban does not rejoin: the membership stays inactive.
    expect((await membershipFor(communityId, targetId))?.active).toBe(false);
  });

  it("kick deactivates the membership with no lasting sanction; the member may rejoin", async () => {
    const ensured = await ensure({
      platform: "discord",
      platformUserId: "t-kick",
      platformGroupId: "g-kick",
    });
    const communityId = ensured.json().data.community.id as string;
    const targetId = ensured.json().data.participant.id as string;

    const kicked = await moderate({
      platform: "discord",
      platformGroupId: "g-kick",
      actorPlatformUserId: "mod",
      targetPlatformUserId: "t-kick",
      action: "kick",
    });
    expect(kicked.json().data.sanctionState).toEqual(CLEARED);
    expect((await membershipFor(communityId, targetId))?.active).toBe(false);

    // A kicked member may rejoin: ensure reactivates the same row.
    const rejoined = await ensure({
      platform: "discord",
      platformUserId: "t-kick",
      platformGroupId: "g-kick",
    });
    expect(rejoined.json().data.reactivated).toBe(true);
    expect((await membershipFor(communityId, targetId))?.active).toBe(true);
  });

  it("bans a non-member: logs the action and sets banned with no membership created", async () => {
    const response = await moderate({
      platform: "discord",
      platformGroupId: "g-nonmember",
      actorPlatformUserId: "mod",
      targetPlatformUserId: "t-never",
      action: "ban",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.sanctionState.banned).toBe(true);
    // No membership row was created by the ban.
    expect((await allMemberships()).length).toBe(0);
    expect((await allActions()).length).toBe(1);
  });
});

describe("derived sanction state with expiry and reversal", () => {
  it("reads a past expiry as lapsed and a more recent future expiry as active until that time", async () => {
    const ensured = await ensure({
      platform: "discord",
      platformUserId: "t-exp",
      platformGroupId: "g-exp",
    });
    const communityId = ensured.json().data.community.id as string;
    const targetId = ensured.json().data.participant.id as string;

    // A mute whose window has already lapsed (created two minutes ago, expired
    // one minute ago) reads as not muted.
    const past = new Date(Date.now() - 60_000);
    await getDb().insert(moderationActions).values({
      communityId,
      actorParticipantId: targetId,
      targetParticipantId: targetId,
      action: "mute",
      expiresAt: past,
      createdAt: new Date(Date.now() - 120_000),
    });
    const lapsed = await stateOf({
      platform: "discord",
      platformGroupId: "g-exp",
      platformUserId: "t-exp",
    });
    expect(lapsed.json().data.muted).toBe(false);

    // A newer mute with a future expiry reads as muted until that time.
    const future = new Date(Date.now() + 3_600_000);
    await getDb().insert(moderationActions).values({
      communityId,
      actorParticipantId: targetId,
      targetParticipantId: targetId,
      action: "mute",
      expiresAt: future,
    });
    const active = await stateOf({
      platform: "discord",
      platformGroupId: "g-exp",
      platformUserId: "t-exp",
    });
    expect(active.json().data.muted).toBe(true);
    expect(new Date(active.json().data.mutedUntil).getTime()).toBe(future.getTime());
  });

  it("supersedes a sanction with a later reversal and re-applies it with a later action", async () => {
    const target = {
      platform: "discord",
      platformGroupId: "g-seq",
      actorPlatformUserId: "mod",
      targetPlatformUserId: "t-seq",
    };

    // A timed ban: banned, with a future bannedUntil (proving the duration set an
    // expiry through make_interval).
    const timedBan = await moderate({ ...target, action: "ban", durationSeconds: 3600 });
    expect(timedBan.json().data.sanctionState.banned).toBe(true);
    const bannedUntil = new Date(timedBan.json().data.sanctionState.bannedUntil).getTime();
    expect(bannedUntil).toBeGreaterThan(Date.now() + 3_000_000);
    expect(bannedUntil).toBeLessThan(Date.now() + 3_600_000 + 10_000);

    // A later unban supersedes it.
    const unbanned = await moderate({ ...target, action: "unban" });
    expect(unbanned.json().data.sanctionState.banned).toBe(false);

    // A later ban re-applies it (indefinite this time).
    const reBanned = await moderate({ ...target, action: "ban" });
    expect(reBanned.json().data.sanctionState.banned).toBe(true);
    expect(reBanned.json().data.sanctionState.bannedUntil).toBeNull();
  });
});

describe("GET /api/v1/moderation/state", () => {
  it("returns the current state, and the cleared state for an unknown member or community", async () => {
    await moderate({
      platform: "discord",
      platformGroupId: "g-read",
      actorPlatformUserId: "mod",
      targetPlatformUserId: "t-read",
      action: "mute",
    });

    const present = await stateOf({
      platform: "discord",
      platformGroupId: "g-read",
      platformUserId: "t-read",
    });
    expect(present.statusCode).toBe(200);
    expect(present.json().data).toEqual({
      muted: true,
      mutedUntil: null,
      banned: false,
      bannedUntil: null,
    });

    // Unknown member in a known community: cleared, nothing created.
    const unknownMember = await stateOf({
      platform: "discord",
      platformGroupId: "g-read",
      platformUserId: "nobody",
    });
    expect(unknownMember.json().data).toEqual(CLEARED);

    // Known member in an unknown community: cleared.
    const unknownCommunity = await stateOf({
      platform: "discord",
      platformGroupId: "g-unknown",
      platformUserId: "t-read",
    });
    expect(unknownCommunity.json().data).toEqual(CLEARED);
  });

  it("returns 401 when the service token is missing", async () => {
    const response = await stateOf(
      { platform: "discord", platformGroupId: "g", platformUserId: "t" },
      { token: false },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /api/v1/moderation/history", () => {
  it("returns the member's actions newest first, paginated", async () => {
    const sequence = ["warn", "mute", "unmute", "warn", "ban"];
    for (const action of sequence) {
      const response = await moderate({
        platform: "discord",
        platformGroupId: "g-hist",
        actorPlatformUserId: "mod",
        targetPlatformUserId: "t-hist",
        action,
      });
      expect(response.statusCode).toBe(200);
    }

    // Page 1 of size 2: the two newest, ban then the second warn.
    const page1 = await historyOf({
      platform: "discord",
      platformGroupId: "g-hist",
      platformUserId: "t-hist",
      page: "1",
      pageSize: "2",
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.pagination).toEqual({ page: 1, pageSize: 2, total: 5 });
    expect(body1.data.map((row: { action: string }) => row.action)).toEqual(["ban", "warn"]);
    // Newest first: created_at is non-increasing across the page.
    expect(new Date(body1.data[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(body1.data[1].createdAt).getTime(),
    );

    // Page 3 of size 2: the single oldest action (the first warn).
    const page3 = await historyOf({
      platform: "discord",
      platformGroupId: "g-hist",
      platformUserId: "t-hist",
      page: "3",
      pageSize: "2",
    });
    const body3 = page3.json();
    expect(body3.pagination).toEqual({ page: 3, pageSize: 2, total: 5 });
    expect(body3.data.map((row: { action: string }) => row.action)).toEqual(["warn"]);
  });

  it("returns an empty page for an unknown member", async () => {
    const response = await historyOf({
      platform: "discord",
      platformGroupId: "g-none",
      platformUserId: "nobody",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(response.json().pagination.total).toBe(0);
  });
});

describe("merge relocation of moderation_actions", () => {
  it("re-points both actor and target foreign keys to the survivor, preserving every row", async () => {
    // A survivor that holds an identity, plus a separate ghost claimed to the
    // same identity, and a third "other" participant.
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
    const otherResolve = await resolveParticipant({ platform: "discord", platformUserId: "o-acct" });
    const otherId = otherResolve.json().data.participant.id as string;

    const community = await resolveCommunity({ platform: "discord", platformGroupId: "g-merge" });
    const communityId = community.json().data.community.id as string;

    // The ghost is the actor of one row, the target of another, and both in a
    // third (a self-row). A correct merge must re-point both columns.
    await getDb()
      .insert(moderationActions)
      .values([
        { communityId, actorParticipantId: ghostId, targetParticipantId: otherId, action: "warn" },
        { communityId, actorParticipantId: otherId, targetParticipantId: ghostId, action: "mute" },
        { communityId, actorParticipantId: ghostId, targetParticipantId: ghostId, action: "warn" },
      ]);

    const merge = await claim({
      platform: "discord",
      platformUserId: "p-acct",
      noclulabsIdentityId: identity,
    });
    expect(merge.statusCode).toBe(200);
    expect(merge.json().data.outcome).toBe("merged");

    // The ghost is deleted and referenced by no row (the guard passed only because
    // both columns were relocated).
    expect(await countParticipants()).toBe(2);
    const danglingGhost = await getDb()
      .select()
      .from(moderationActions)
      .where(
        or(
          eq(moderationActions.actorParticipantId, ghostId),
          eq(moderationActions.targetParticipantId, ghostId),
        ),
      );
    expect(danglingGhost.length).toBe(0);

    // All three rows survive, now pointing at the survivor where they pointed at
    // the ghost: actor in rows 1 and 3, target in rows 2 and 3.
    const rows = await allActions();
    expect(rows.length).toBe(3);
    expect(rows.filter((row) => row.actorParticipantId === survivorId).length).toBe(2);
    expect(rows.filter((row) => row.targetParticipantId === survivorId).length).toBe(2);
  });
});

describe("moderation action validation", () => {
  const base = {
    platform: "discord",
    platformGroupId: "g-v",
    actorPlatformUserId: "mod",
    targetPlatformUserId: "t-v",
  };

  it("rejects an unknown action with a 400", async () => {
    const response = await moderate({ ...base, action: "explode" });
    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);
    // Nothing was logged.
    expect((await allActions()).length).toBe(0);
  });

  it("rejects a zero, negative, fractional, or absurd durationSeconds with a 400", async () => {
    for (const durationSeconds of [0, -5, 1.5, MAX_DURATION_SECONDS + 1]) {
      const response = await moderate({ ...base, action: "mute", durationSeconds });
      expect(response.statusCode, `durationSeconds=${durationSeconds}`).toBe(400);
      expect(response.json().success).toBe(false);
    }
    expect((await allActions()).length).toBe(0);
  });

  it("rejects a reason longer than the bound with a 400", async () => {
    const response = await moderate({ ...base, action: "warn", reason: "x".repeat(1001) });
    expect(response.statusCode).toBe(400);
  });

  it("returns 401 when the service token is missing", async () => {
    const response = await moderate({ ...base, action: "warn" }, { token: false });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});
