import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "@/server.js";
import { closeDb, getDb } from "@/lib/db/index.js";
import { closeRedis } from "@/lib/redis/index.js";
import { participants, syncWatermarks } from "@/lib/db/schema/index.js";
import {
  CONTRIBUTION_CAP_LEVEL,
  trueScoreContribution,
  xpForLevel,
} from "@/lib/leveling/index.js";
import { XP_PER_GRANT } from "@/services/engagement/grant.js";
import { claimAndEmit } from "@/services/emit-sync/claim-and-emit.js";
import {
  NETWORK_LEVEL_SIGNAL_TYPE,
  resetEmitRuntimeForTest,
  setEmitRuntimeForTest,
  type EmitSyncLogger,
} from "@/services/emit-sync/emit.js";
import type { EmitResult, EmitSignalParams, SignalsClient } from "@/lib/noclulabs/signals.js";
import { createVerifySyncPoller, type VerifySyncLogger } from "@/services/verify-sync/poller.js";
import { dbWatermarkStore } from "@/services/verify-sync/watermark.js";
import { DISCORD_PROVIDER, DISCORD_VERIFIED_STREAM } from "@/services/verify-sync/streams.js";
import type {
  VerifiedConnection,
  VerifiedConnectionsClient,
  VerifiedConnectionsPage,
} from "@/lib/noclulabs/verified-connections.js";
import { resetDb } from "../helpers/db.js";
import { TEST_SERVICE_TOKEN } from "../constants.js";

let app: FastifyInstance;

const silentLogger: EmitSyncLogger = { warn() {}, error() {} };
const silentVerifyLogger: VerifySyncLogger = { info() {}, warn() {}, error() {} };

function post(url: string, body: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      "x-service-token": TEST_SERVICE_TOKEN,
      "x-service-name": "test-bot",
    },
    payload: JSON.stringify(body),
  });
}

const engage = (body: unknown) => post("/api/v1/engagement", body);
const resolveP = (body: unknown) => post("/api/v1/participants/resolve", body);
const claimRoute = (body: unknown) => post("/api/v1/participants/claim", body);

// A fake SignalsClient that records every emit and returns a controllable outcome.
// Injected through the emit runtime seam so the real orchestration runs offline.
function makeFakeSignals(
  behavior: (params: EmitSignalParams) => EmitResult | Promise<EmitResult> = () => ({
    kind: "written",
    written: true,
  }),
): { client: SignalsClient; calls: EmitSignalParams[] } {
  const calls: EmitSignalParams[] = [];
  const client: SignalsClient = {
    async emit(params: EmitSignalParams): Promise<EmitResult> {
      calls.push(params);
      return behavior(params);
    },
  };
  return { client, calls };
}

function enableEmit(client: SignalsClient): void {
  setEmitRuntimeForTest({ client, enabled: true, logger: silentLogger });
}

// A fake surface-B client over an in-memory dataset, mirroring the cursor semantics
// the verify-sync suite uses, so the poller path can be driven offline.
function makeSurfaceB(connections: VerifiedConnection[]): VerifiedConnectionsClient {
  const sorted = [...connections].sort((a, b) =>
    a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0,
  );
  return {
    async fetch({ since, limit }): Promise<VerifiedConnectionsPage> {
      const after = since ?? "";
      const matching = sorted.filter((connection) => connection.cursor > after).slice(0, limit);
      const last = matching[matching.length - 1];
      return {
        connections: matching.map((connection) => ({ ...connection })),
        nextCursor: last === undefined ? null : last.cursor,
      };
    },
  };
}

function conn(n: number, identity = randomUUID()): VerifiedConnection {
  const idx = String(n).padStart(3, "0");
  return {
    provider: "discord",
    providerAccountId: `discord-user-${idx}`,
    noclulabsIdentityId: identity,
    cursor: `c${idx}`,
  };
}

async function participantById(id: string) {
  const rows = await getDb().select().from(participants).where(eq(participants.id, id));
  return rows[0];
}

async function linkParticipant(id: string, identityId: string): Promise<void> {
  await getDb()
    .update(participants)
    .set({ noclulabsIdentityId: identityId })
    .where(eq(participants.id, id));
}

async function setXp(id: string, xp: number): Promise<void> {
  await getDb().update(participants).set({ networkXp: xp }).where(eq(participants.id, id));
}

async function watermarkCursor(): Promise<string | null | undefined> {
  const rows = await getDb()
    .select()
    .from(syncWatermarks)
    .where(eq(syncWatermarks.stream, DISCORD_VERIFIED_STREAM));
  return rows[0]?.cursor;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeRedis();
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  // Always clear the emit override so a later case is not silently enabled.
  resetEmitRuntimeForTest();
});

describe("emit-sync: level-up gate", () => {
  it("emits once with the new level's value when an engagement crosses a level boundary", async () => {
    const identity = randomUUID();
    const created = await resolveP({ platform: "discord", platformUserId: "u-lvlup" });
    const pid = created.json().data.participant.id as string;
    await linkParticipant(pid, identity);
    // Stand the participant just below the level 5 threshold; one grant crosses it.
    await setXp(pid, xpForLevel(5) - 5);

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const response = await engage({
      platform: "discord",
      platformUserId: "u-lvlup",
      platformGroupId: "g-lvlup",
    });
    expect(response.json().data.granted).toBe(true);
    expect(response.json().data.leveledUp).toBe(true);
    expect(response.json().data.participant.networkLevel).toBe(5);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.subjectIdentityId).toBe(identity);
    expect(call.signalType).toBe(NETWORK_LEVEL_SIGNAL_TYPE);
    expect(call.value).toBe(trueScoreContribution(xpForLevel(5) - 5 + XP_PER_GRANT));
    expect(call.value).toBe(5 / CONTRIBUTION_CAP_LEVEL);
    // observedAt is a valid ISO 8601 timestamp.
    expect(Number.isNaN(Date.parse(call.observedAt))).toBe(false);
  });

  it("emits nothing when an engagement does not cross a level boundary", async () => {
    const identity = randomUUID();
    const created = await resolveP({ platform: "discord", platformUserId: "u-nocross" });
    const pid = created.json().data.participant.id as string;
    await linkParticipant(pid, identity);
    // Exactly at the level 5 threshold; a 20 XP grant stays within level 5 (the
    // level 5 to 6 gap is far larger than the grant).
    await setXp(pid, xpForLevel(5));

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const response = await engage({
      platform: "discord",
      platformUserId: "u-nocross",
      platformGroupId: "g-nocross",
    });
    expect(response.json().data.granted).toBe(true);
    expect(response.json().data.leveledUp).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("emit-sync: value correctness", () => {
  it("emits exactly trueScoreContribution for the participant's level, saturating at the cap", async () => {
    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const levels = [5, 10, CONTRIBUTION_CAP_LEVEL, CONTRIBUTION_CAP_LEVEL + 10];
    for (const [i, level] of levels.entries()) {
      const userId = `u-val-${level}`;
      const identity = randomUUID();
      const created = await resolveP({ platform: "discord", platformUserId: userId });
      const pid = created.json().data.participant.id as string;
      const xp = xpForLevel(level);
      await setXp(pid, xp);

      const result = await claimAndEmit({
        platform: "discord",
        platformUserId: userId,
        noclulabsIdentityId: identity,
      });
      expect(result.outcome).toBe("claimed");

      expect(calls).toHaveLength(i + 1);
      const call = calls[i]!;
      expect(call.subjectIdentityId).toBe(identity);
      expect(call.value).toBe(trueScoreContribution(xp));
      expect(call.value).toBe(Math.min(level, CONTRIBUTION_CAP_LEVEL) / CONTRIBUTION_CAP_LEVEL);
    }
    // Level 50 and level 60 both saturate at 1.0.
    expect(calls[2]!.value).toBe(1);
    expect(calls[3]!.value).toBe(1);
  });
});

describe("emit-sync: claim and merge triggers", () => {
  it("emits the claimed participant's current contribution after a claim", async () => {
    const identity = randomUUID();
    const created = await resolveP({ platform: "discord", platformUserId: "u-claim-xp" });
    const pid = created.json().data.participant.id as string;
    await setXp(pid, xpForLevel(7));

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const result = await claimAndEmit({
      platform: "discord",
      platformUserId: "u-claim-xp",
      noclulabsIdentityId: identity,
    });
    expect(result.outcome).toBe("claimed");
    expect(result.participant.id).toBe(pid);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subjectIdentityId).toBe(identity);
    expect(calls[0]!.value).toBe(trueScoreContribution(xpForLevel(7)));
  });

  it("emits the survivor's contribution for the summed level after a merge", async () => {
    const identity = randomUUID();
    // Build the survivor and the ghost with emit disabled (the default), then enable
    // for the merge so only the merge's emit is observed.
    const survivorClaim = await claimRoute({
      platform: "discord",
      platformUserId: "s-merge",
      noclulabsIdentityId: identity,
    });
    const survivorId = survivorClaim.json().data.participant.id as string;
    const ghostResolve = await resolveP({ platform: "discord", platformUserId: "p-merge" });
    const ghostId = ghostResolve.json().data.participant.id as string;
    await setXp(survivorId, 100);
    await setXp(ghostId, 250);

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const result = await claimAndEmit({
      platform: "discord",
      platformUserId: "p-merge",
      noclulabsIdentityId: identity,
    });
    expect(result.outcome).toBe("merged");
    expect(result.participant.id).toBe(survivorId);
    expect((await participantById(survivorId))?.networkXp).toBe(350);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subjectIdentityId).toBe(identity);
    // The summed level's contribution, not either input's.
    expect(calls[0]!.value).toBe(trueScoreContribution(350));
  });
});

describe("emit-sync: one shared trigger point", () => {
  it("emits from the claim route path", async () => {
    const identity = randomUUID();
    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const response = await claimRoute({
      platform: "discord",
      platformUserId: "u-route",
      noclulabsIdentityId: identity,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("claimed");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.subjectIdentityId).toBe(identity);
    // A freshly claimed ghost has 0 XP, so level 0, so contribution 0.
    expect(calls[0]!.value).toBe(0);
  });

  it("emits from the verify-sync poller's claim driver (the wrapper is in the poller path)", async () => {
    const data = [conn(1), conn(2), conn(3)];
    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const poller = createVerifySyncPoller({
      client: makeSurfaceB(data),
      claim: claimAndEmit,
      watermarks: dbWatermarkStore,
      logger: silentVerifyLogger,
      provider: DISCORD_PROVIDER,
      stream: DISCORD_VERIFIED_STREAM,
      pageSize: 200,
      now: () => new Date(),
    });

    const result = await poller.runIncrementalCycle();
    expect(result.claimed).toBe(3);

    // One emit per claimed connection, carrying each connection's identity.
    expect(calls).toHaveLength(3);
    const emittedSubjects = calls.map((c) => c.subjectIdentityId).sort();
    const expectedSubjects = data.map((d) => d.noclulabsIdentityId).sort();
    expect(emittedSubjects).toEqual(expectedSubjects);
    expect(calls.every((c) => c.value === 0)).toBe(true);
  });
});

describe("emit-sync: best-effort isolation", () => {
  const throwingSignals = () =>
    makeFakeSignals(() => {
      throw new Error("simulated emit failure");
    });

  it("a failing emit does not fail an engagement", async () => {
    const identity = randomUUID();
    const created = await resolveP({ platform: "discord", platformUserId: "u-iso-eng" });
    const pid = created.json().data.participant.id as string;
    await linkParticipant(pid, identity);
    await setXp(pid, xpForLevel(5) - 5);

    const { client, calls } = throwingSignals();
    enableEmit(client);

    const response = await engage({
      platform: "discord",
      platformUserId: "u-iso-eng",
      platformGroupId: "g-iso-eng",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.granted).toBe(true);
    expect(response.json().data.leveledUp).toBe(true);
    // The emit was attempted and threw, but the grant landed.
    expect(calls).toHaveLength(1);
    expect((await participantById(pid))?.networkXp).toBe(xpForLevel(5) - 5 + XP_PER_GRANT);
  });

  it("a failing emit does not fail a claim or a merge", async () => {
    const identity = randomUUID();
    const { client, calls } = throwingSignals();
    enableEmit(client);

    // Claim a ghost; the emit throws but the claim succeeds.
    const claimResult = await claimAndEmit({
      platform: "discord",
      platformUserId: "u-iso-claim",
      noclulabsIdentityId: identity,
    });
    expect(claimResult.outcome).toBe("claimed");

    // A second account merges in; the emit throws but the merge succeeds.
    const ghostResolve = await resolveP({ platform: "discord", platformUserId: "p-iso-merge" });
    const ghostId = ghostResolve.json().data.participant.id as string;
    const mergeResult = await claimAndEmit({
      platform: "discord",
      platformUserId: "p-iso-merge",
      noclulabsIdentityId: identity,
    });
    expect(mergeResult.outcome).toBe("merged");
    expect(await participantById(ghostId)).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("a failing emit does not stop or alter a poller cycle (the watermark still advances page-atomically)", async () => {
    const data = [conn(1), conn(2), conn(3), conn(4), conn(5)];
    const { client, calls } = throwingSignals();
    enableEmit(client);

    const poller = createVerifySyncPoller({
      client: makeSurfaceB(data),
      claim: claimAndEmit,
      watermarks: dbWatermarkStore,
      logger: silentVerifyLogger,
      provider: DISCORD_PROVIDER,
      stream: DISCORD_VERIFIED_STREAM,
      pageSize: 2,
      now: () => new Date(),
    });

    const result = await poller.runIncrementalCycle();
    // Every connection claimed despite every emit throwing; the watermark advanced
    // to the last cursor, exactly as it would with no emit at all.
    expect(result.claimed).toBe(5);
    expect(result.connectionsProcessed).toBe(5);
    expect(calls).toHaveLength(5);
    expect(await watermarkCursor()).toBe("c005");
  });
});

describe("emit-sync: stale link and invalid request", () => {
  it("sets the stale marker on unknown_subject and emits nothing for that subject afterward", async () => {
    const identity = randomUUID();
    const { client, calls } = makeFakeSignals(() => ({ kind: "unknown_subject" }));
    enableEmit(client);

    // First claim links the participant and emits; the emit returns unknown_subject.
    const first = await claimAndEmit({
      platform: "discord",
      platformUserId: "u-stale",
      noclulabsIdentityId: identity,
    });
    const pid = first.participant.id;
    expect(calls).toHaveLength(1);
    // The marker is now set.
    expect((await participantById(pid))?.identityEmitDisabledAt).not.toBeNull();

    // A subsequent triggering event for the same participant emits nothing.
    calls.length = 0;
    const second = await claimAndEmit({
      platform: "discord",
      platformUserId: "u-stale",
      noclulabsIdentityId: identity,
    });
    expect(second.outcome).toBe("already_linked");
    expect(calls).toHaveLength(0);
  });

  it("does not set the marker on invalid_request and keeps emitting on later events", async () => {
    const identity = randomUUID();
    const { client, calls } = makeFakeSignals(() => ({ kind: "invalid_request" }));
    enableEmit(client);

    const first = await claimAndEmit({
      platform: "discord",
      platformUserId: "u-invalid",
      noclulabsIdentityId: identity,
    });
    const pid = first.participant.id;
    expect(calls).toHaveLength(1);
    // invalid_request is a request bug, not a stale link: the marker stays null.
    expect((await participantById(pid))?.identityEmitDisabledAt).toBeNull();

    // A later event still emits (the subject is not disabled).
    calls.length = 0;
    await claimAndEmit({
      platform: "discord",
      platformUserId: "u-invalid",
      noclulabsIdentityId: identity,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("emit-sync: skip ghosts and disabled subjects", () => {
  it("emits nothing for a ghost (no noclulabs subject)", async () => {
    const created = await resolveP({ platform: "discord", platformUserId: "u-ghost" });
    const pid = created.json().data.participant.id as string;
    // A ghost with earned XP that crosses a level on engagement, but no identity.
    await setXp(pid, xpForLevel(5) - 5);

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const response = await engage({
      platform: "discord",
      platformUserId: "u-ghost",
      platformGroupId: "g-ghost",
    });
    expect(response.json().data.leveledUp).toBe(true);
    // The orchestration skips a ghost: no emit.
    expect(calls).toHaveLength(0);
  });

  it("emits nothing for a participant already marked as a stale link", async () => {
    const identity = randomUUID();
    const created = await resolveP({ platform: "discord", platformUserId: "u-disabled" });
    const pid = created.json().data.participant.id as string;
    await linkParticipant(pid, identity);
    await setXp(pid, xpForLevel(5) - 5);
    await getDb()
      .update(participants)
      .set({ identityEmitDisabledAt: new Date() })
      .where(eq(participants.id, pid));

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const response = await engage({
      platform: "discord",
      platformUserId: "u-disabled",
      platformGroupId: "g-disabled",
    });
    expect(response.json().data.leveledUp).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("emit-sync: config gating", () => {
  it("emits nothing and touches no network when the emit is disabled", async () => {
    // No runtime override: the orchestration falls back to the config flag, which is
    // off in the test env. A fetch spy proves nothing reaches the network.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const identity = randomUUID();

    const claimed = await claimRoute({
      platform: "discord",
      platformUserId: "u-off",
      noclulabsIdentityId: identity,
    });
    expect(claimed.json().data.outcome).toBe("claimed");

    const created = await resolveP({ platform: "discord", platformUserId: "u-off-2" });
    const pid = created.json().data.participant.id as string;
    await linkParticipant(pid, randomUUID());
    await setXp(pid, xpForLevel(5) - 5);
    const engaged = await engage({
      platform: "discord",
      platformUserId: "u-off-2",
      platformGroupId: "g-off-2",
    });
    expect(engaged.json().data.leveledUp).toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
