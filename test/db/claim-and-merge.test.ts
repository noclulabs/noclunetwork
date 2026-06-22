import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "@/server.js";
import { closeDb, getDb } from "@/lib/db/index.js";
import { participants, platformAccounts } from "@/lib/db/schema/index.js";
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

const resolve = (body: unknown) => post("/api/v1/participants/resolve", body);
const claim = (body: unknown, options?: { token?: boolean }) =>
  post("/api/v1/participants/claim", body, options);

async function countParticipants(): Promise<number> {
  return (await getDb().select().from(participants)).length;
}

async function participantById(id: string) {
  const rows = await getDb().select().from(participants).where(eq(participants.id, id));
  return rows[0];
}

async function accountsFor(participantId: string) {
  return getDb()
    .select()
    .from(platformAccounts)
    .where(eq(platformAccounts.participantId, participantId));
}

async function accountByUserId(platformUserId: string) {
  const rows = await getDb()
    .select()
    .from(platformAccounts)
    .where(eq(platformAccounts.platformUserId, platformUserId));
  return rows[0];
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

describe("POST /api/v1/participants/claim", () => {
  // Case 2: already linked.
  it("returns already_linked and stays idempotent when the account already holds the identity", async () => {
    const identity = randomUUID();
    const first = await claim({
      platform: "discord",
      platformUserId: "u-linked",
      noclulabsIdentityId: identity,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.outcome).toBe("claimed");
    const participantId = first.json().data.participant.id as string;

    const second = await claim({
      platform: "discord",
      platformUserId: "u-linked",
      noclulabsIdentityId: identity,
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.data.outcome).toBe("already_linked");
    expect(body.data.participant.id).toBe(participantId);
    expect(body.data.participant.noclulabsIdentityId).toBe(identity);
    expect(body.data.mergedParticipantId).toBeUndefined();

    expect(await countParticipants()).toBe(1);
    expect((await accountByUserId("u-linked"))?.verified).toBe(true);

    // A third identical claim is still idempotent.
    const third = await claim({
      platform: "discord",
      platformUserId: "u-linked",
      noclulabsIdentityId: identity,
    });
    expect(third.json().data.outcome).toBe("already_linked");
    expect(await countParticipants()).toBe(1);
  });

  // Case 3: conflict.
  it("returns 409 and changes nothing when the account is verified to a different identity", async () => {
    const identityA = randomUUID();
    const identityB = randomUUID();
    const first = await claim({
      platform: "discord",
      platformUserId: "u-conflict",
      noclulabsIdentityId: identityA,
    });
    expect(first.json().data.outcome).toBe("claimed");
    const participantId = first.json().data.participant.id as string;

    const conflict = await claim({
      platform: "discord",
      platformUserId: "u-conflict",
      noclulabsIdentityId: identityB,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().success).toBe(false);
    expect(conflict.json().error.code).toBe("ACCOUNT_ALREADY_VERIFIED");

    // Nothing changed: still one participant, still linked to identityA.
    expect(await countParticipants()).toBe(1);
    expect((await accountByUserId("u-conflict"))?.participantId).toBe(participantId);
    expect((await participantById(participantId))?.noclulabsIdentityId).toBe(identityA);
  });

  // Case 4: claim in place.
  it("claims a ghost in place when no participant holds the identity", async () => {
    const created = await resolve({ platform: "discord", platformUserId: "u-claim" });
    expect(created.json().data.created).toBe(true);
    expect(created.json().data.participant.noclulabsIdentityId).toBeNull();
    const ghostId = created.json().data.participant.id as string;

    const identity = randomUUID();
    const response = await claim({
      platform: "discord",
      platformUserId: "u-claim",
      noclulabsIdentityId: identity,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.outcome).toBe("claimed");
    // Same participant, linked in place (no merge).
    expect(body.data.participant.id).toBe(ghostId);
    expect(body.data.participant.noclulabsIdentityId).toBe(identity);
    expect(body.data.mergedParticipantId).toBeUndefined();

    expect((await accountByUserId("u-claim"))?.verified).toBe(true);
    expect(await countParticipants()).toBe(1);
  });

  // Case 5: merge.
  it("merges a ghost into the participant that already holds the identity", async () => {
    const identity = randomUUID();
    // The survivor S, linked to the identity through its own account.
    const survivorClaim = await claim({
      platform: "discord",
      platformUserId: "s-acct",
      noclulabsIdentityId: identity,
    });
    expect(survivorClaim.json().data.outcome).toBe("claimed");
    const survivorId = survivorClaim.json().data.participant.id as string;

    // A separate ghost P with its own account.
    const ghostResolve = await resolve({ platform: "discord", platformUserId: "p-acct" });
    const ghostId = ghostResolve.json().data.participant.id as string;
    expect(ghostId).not.toBe(survivorId);
    expect(await countParticipants()).toBe(2);

    const response = await claim({
      platform: "discord",
      platformUserId: "p-acct",
      noclulabsIdentityId: identity,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.outcome).toBe("merged");
    // The survivor is the identity-bearer.
    expect(body.data.participant.id).toBe(survivorId);
    expect(body.data.participant.noclulabsIdentityId).toBe(identity);
    expect(body.data.mergedParticipantId).toBe(ghostId);

    // The ghost is gone; the survivor owns both accounts.
    expect(await countParticipants()).toBe(1);
    expect(await participantById(ghostId)).toBeUndefined();
    const userIds = (await accountsFor(survivorId)).map((a) => a.platformUserId).sort();
    expect(userIds).toEqual(["p-acct", "s-acct"]);
    // The claimed account is re-pointed to the survivor and verified.
    const claimed = await accountByUserId("p-acct");
    expect(claimed?.participantId).toBe(survivorId);
    expect(claimed?.verified).toBe(true);
  });

  // Merge folds the ghost's lifetime XP into the survivor.
  it("sums the ghost's network_xp into the survivor on merge", async () => {
    const identity = randomUUID();
    const survivorClaim = await claim({
      platform: "discord",
      platformUserId: "s-xp",
      noclulabsIdentityId: identity,
    });
    const survivorId = survivorClaim.json().data.participant.id as string;

    const ghostResolve = await resolve({ platform: "discord", platformUserId: "p-xp" });
    const ghostId = ghostResolve.json().data.participant.id as string;

    // Both carry lifetime network XP before the merge.
    await getDb().update(participants).set({ networkXp: 100 }).where(eq(participants.id, survivorId));
    await getDb().update(participants).set({ networkXp: 250 }).where(eq(participants.id, ghostId));

    const response = await claim({
      platform: "discord",
      platformUserId: "p-xp",
      noclulabsIdentityId: identity,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("merged");
    expect(response.json().data.participant.id).toBe(survivorId);

    // The survivor's lifetime total is the sum of both; the ghost is gone.
    expect((await participantById(survivorId))?.networkXp).toBe(350);
    expect(await participantById(ghostId)).toBeUndefined();
    expect(await countParticipants()).toBe(1);
  });

  // Case 1 precondition: resolve-or-create on claim.
  it("resolve-or-creates the account on a claim for a never-seen platform user, then claims in place", async () => {
    const identity = randomUUID();
    expect(await countParticipants()).toBe(0);

    const response = await claim({
      platform: "discord",
      platformUserId: "never-seen",
      noclulabsIdentityId: identity,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.outcome).toBe("claimed");
    expect(body.data.participant.noclulabsIdentityId).toBe(identity);

    expect(await countParticipants()).toBe(1);
    const account = await accountByUserId("never-seen");
    expect(account).toBeDefined();
    expect(account?.verified).toBe(true);
    expect(account?.isPrimary).toBe(true);
  });

  // USER_HAS_DATA: every owned row must move before the ghost is deleted.
  it("relocates all of a multi-account ghost's accounts on merge (USER_HAS_DATA holds)", async () => {
    const identity = randomUUID();
    const survivorClaim = await claim({
      platform: "discord",
      platformUserId: "s-main",
      noclulabsIdentityId: identity,
    });
    const survivorId = survivorClaim.json().data.participant.id as string;

    // A ghost with two platform accounts: one via resolve, a second inserted directly.
    const ghostResolve = await resolve({ platform: "discord", platformUserId: "p-main" });
    const ghostId = ghostResolve.json().data.participant.id as string;
    await getDb().insert(platformAccounts).values({
      participantId: ghostId,
      platform: "discord",
      platformUserId: "p-second",
    });
    expect((await accountsFor(ghostId)).length).toBe(2);

    const response = await claim({
      platform: "discord",
      platformUserId: "p-main",
      noclulabsIdentityId: identity,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("merged");
    expect(response.json().data.mergedParticipantId).toBe(ghostId);

    // Every account moved to the survivor; the ghost is gone and owns nothing.
    expect(await countParticipants()).toBe(1);
    expect(await participantById(ghostId)).toBeUndefined();
    expect((await accountsFor(ghostId)).length).toBe(0);
    const survivorUserIds = (await accountsFor(survivorId)).map((a) => a.platformUserId).sort();
    expect(survivorUserIds).toEqual(["p-main", "p-second", "s-main"]);
  });

  // Concurrency: two simultaneous claims of the same account and identity are
  // serialized by the account row lock (FOR UPDATE).
  it("serializes two simultaneous claims of the same account and identity", async () => {
    const identity = randomUUID();
    // A pre-existing survivor, so the racing claims contend on a merge.
    const survivorClaim = await claim({
      platform: "discord",
      platformUserId: "s-race",
      noclulabsIdentityId: identity,
    });
    const survivorId = survivorClaim.json().data.participant.id as string;

    const [a, b] = await Promise.all([
      claim({ platform: "discord", platformUserId: "p-race", noclulabsIdentityId: identity }),
      claim({ platform: "discord", platformUserId: "p-race", noclulabsIdentityId: identity }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const bodyA = a.json();
    const bodyB = b.json();
    // Both resolve to the same surviving participant (the identity-bearer).
    expect(bodyA.data.participant.id).toBe(survivorId);
    expect(bodyB.data.participant.id).toBe(survivorId);
    // Exactly one merge occurred; the other is an idempotent no-op.
    const outcomes = [bodyA.data.outcome, bodyB.data.outcome].sort();
    expect(outcomes).toEqual(["already_linked", "merged"]);
    // No duplicate participant; the ghost is gone, the racing account re-pointed.
    expect(await countParticipants()).toBe(1);
    const raced = await accountByUserId("p-race");
    expect(raced?.participantId).toBe(survivorId);
    expect(raced?.verified).toBe(true);
  });
});

describe("POST /api/v1/participants/claim validation", () => {
  it("accepts a uuidv7 identity id (ids in this estate default to uuidv7)", async () => {
    const v7 = "018f4e2a-9c7b-7d3e-8a1f-2b3c4d5e6f70";
    const response = await claim({
      platform: "discord",
      platformUserId: "u-v7",
      noclulabsIdentityId: v7,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.participant.noclulabsIdentityId).toBe(v7);
  });

  it("returns 400 for a malformed identity id", async () => {
    const response = await claim({
      platform: "discord",
      platformUserId: "u-bad",
      noclulabsIdentityId: "not-a-uuid",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);
  });

  it("returns 400 for a platform absent from the registry", async () => {
    const response = await claim({
      platform: "telegram",
      platformUserId: "u-x",
      noclulabsIdentityId: randomUUID(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);
  });

  it("returns 401 when the service token is missing", async () => {
    const response = await claim(
      { platform: "discord", platformUserId: "u-x", noclulabsIdentityId: randomUUID() },
      { token: false },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});
