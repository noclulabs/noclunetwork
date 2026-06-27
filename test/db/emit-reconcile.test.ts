import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/lib/db/index.js";
import { participants } from "@/lib/db/schema/index.js";
import { trueScoreContribution, xpForLevel } from "@/lib/leveling/index.js";
import {
  NETWORK_LEVEL_SIGNAL_TYPE,
  resetEmitRuntimeForTest,
  setEmitRuntimeForTest,
  type EmitSyncLogger,
} from "@/services/emit-sync/emit.js";
import { runReconcileCycle, type SelectBatchFn } from "@/services/emit-sync/reconcile.js";
import type { EmitResult, EmitSignalParams, SignalsClient } from "@/lib/noclulabs/signals.js";
import { resetDb } from "../helpers/db.js";

// The reconcile job runs against the real test Postgres with the injected fake
// signals client, so the real emit orchestration drives every emit fully offline.
// It does not build the app: the job and the orchestration both use getDb() and the
// emit seam directly, so the pass is exercised in isolation, with no routes, no
// Redis, and no network.

const silentLogger: EmitSyncLogger = { warn() {}, error() {} };

// A fake SignalsClient that records every emit and returns a controllable outcome,
// injected through the emit runtime seam so the real orchestration runs offline.
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

// Insert a participant directly. A claimed participant carries a distinct identity
// (the column is unique); a ghost carries a null identity; a stale link carries a
// non-null identity_emit_disabled_at.
async function insertParticipant(opts: {
  identityId?: string | null;
  xp?: number;
  staleAt?: Date | null;
} = {}): Promise<string> {
  const rows = await getDb()
    .insert(participants)
    .values({
      noclulabsIdentityId: opts.identityId ?? null,
      networkXp: opts.xp ?? 0,
      identityEmitDisabledAt: opts.staleAt ?? null,
    })
    .returning({ id: participants.id });
  return rows[0]!.id;
}

async function participantById(id: string) {
  const rows = await getDb().select().from(participants).where(eq(participants.id, id));
  return rows[0];
}

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  resetEmitRuntimeForTest();
});

describe("emit-reconcile: re-emits current contributions", () => {
  it("re-emits a claimed participant's current contribution (an unlanded value lands)", async () => {
    const identity = randomUUID();
    const xp = xpForLevel(7);
    await insertParticipant({ identityId: identity, xp });

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const result = await runReconcileCycle();

    expect(result.participantsProcessed).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.subjectIdentityId).toBe(identity);
    expect(call.signalType).toBe(NETWORK_LEVEL_SIGNAL_TYPE);
    expect(call.value).toBe(trueScoreContribution(xp));
    // observedAt is the current time, a valid ISO 8601 timestamp.
    expect(Number.isNaN(Date.parse(call.observedAt))).toBe(false);
  });

  it("is a cheap no-op when the value is already current (the server returns written false)", async () => {
    const identity = randomUUID();
    await insertParticipant({ identityId: identity, xp: xpForLevel(3) });

    // The dedup case: an unchanged value writes nothing on the server.
    const { client, calls } = makeFakeSignals(() => ({ kind: "written", written: false }));
    enableEmit(client);

    const result = await runReconcileCycle();

    expect(result.participantsProcessed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subjectIdentityId).toBe(identity);
  });
});

describe("emit-reconcile: pagination", () => {
  it("processes more participants than one batch, advancing the keyset across batches", async () => {
    const identities = Array.from({ length: 5 }, () => randomUUID());
    for (const identity of identities) {
      await insertParticipant({ identityId: identity, xp: xpForLevel(4) });
    }

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const result = await runReconcileCycle({ batchSize: 2 });

    // Every participant processed exactly once, across 2 + 2 + 1 batches.
    expect(result.participantsProcessed).toBe(5);
    expect(result.batches).toBe(3);
    expect(calls).toHaveLength(5);
    const emitted = calls.map((c) => c.subjectIdentityId).sort();
    expect(emitted).toEqual([...identities].sort());
  });
});

describe("emit-reconcile: query-level skips", () => {
  it("does not feed ghosts or stale-marked participants to the orchestration", async () => {
    const claimedA = randomUUID();
    const claimedB = randomUUID();
    const stale = randomUUID();
    const claimedAId = await insertParticipant({ identityId: claimedA, xp: xpForLevel(2) });
    const claimedBId = await insertParticipant({ identityId: claimedB, xp: xpForLevel(2) });
    // A ghost (null identity) and a confirmed stale link (marker set).
    const ghostId = await insertParticipant({ identityId: null, xp: xpForLevel(2) });
    const staleId = await insertParticipant({
      identityId: stale,
      xp: xpForLevel(2),
      staleAt: new Date(),
    });

    // Inject an emit spy so we can prove exactly which participants the query feeds
    // to the orchestration, independent of the orchestration's own internal checks.
    const fed: string[] = [];
    const result = await runReconcileCycle({
      emit: async (participantId: string) => {
        fed.push(participantId);
      },
    });

    expect(result.participantsProcessed).toBe(2);
    expect([...fed].sort()).toEqual([claimedAId, claimedBId].sort());
    expect(fed).not.toContain(ghostId);
    expect(fed).not.toContain(staleId);
  });
});

describe("emit-reconcile: best-effort isolation", () => {
  it("continues the pass when one participant's emit fails", async () => {
    const identities = Array.from({ length: 3 }, () => randomUUID());
    for (const identity of identities) {
      await insertParticipant({ identityId: identity, xp: xpForLevel(4) });
    }
    const failingSubject = identities[1]!;

    // The middle participant's emit throws; the orchestration swallows it.
    const { client, calls } = makeFakeSignals((params) => {
      if (params.subjectIdentityId === failingSubject) {
        throw new Error("simulated emit failure");
      }
      return { kind: "written", written: true };
    });
    enableEmit(client);

    const result = await runReconcileCycle({ batchSize: 2 });

    // Every participant was processed despite the one failure.
    expect(result.participantsProcessed).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.subjectIdentityId).sort()).toEqual([...identities].sort());
  });
});

describe("emit-reconcile: stale marker during a pass", () => {
  it("sets the marker on unknown_subject, continues, and excludes the subject next pass", async () => {
    const staleIdentity = randomUUID();
    const liveIdentity = randomUUID();
    const staleId = await insertParticipant({ identityId: staleIdentity, xp: xpForLevel(3) });
    const liveId = await insertParticipant({ identityId: liveIdentity, xp: xpForLevel(3) });

    // The stale participant's subject is unknown on noclulabs.com; the live one is fine.
    const { client, calls } = makeFakeSignals((params) =>
      params.subjectIdentityId === staleIdentity
        ? { kind: "unknown_subject" }
        : { kind: "written", written: true },
    );
    enableEmit(client);

    const first = await runReconcileCycle();
    expect(first.participantsProcessed).toBe(2);
    expect(calls).toHaveLength(2);
    // The orchestration set the stale marker on the unknown subject.
    expect((await participantById(staleId))?.identityEmitDisabledAt).not.toBeNull();
    expect((await participantById(liveId))?.identityEmitDisabledAt).toBeNull();

    // A second pass excludes the now-stale participant (the query filters it out).
    calls.length = 0;
    const second = await runReconcileCycle();
    expect(second.participantsProcessed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subjectIdentityId).toBe(liveIdentity);
  });
});

describe("emit-reconcile: stateless full pass", () => {
  it("re-scans from the beginning each cycle, with no watermark carried over", async () => {
    const identities = Array.from({ length: 3 }, () => randomUUID());
    for (const identity of identities) {
      await insertParticipant({ identityId: identity, xp: xpForLevel(4) });
    }

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    const first = await runReconcileCycle();
    expect(first.participantsProcessed).toBe(3);
    expect(calls).toHaveLength(3);

    // A second cycle re-emits every participant: a fresh full pass, no watermark.
    calls.length = 0;
    const second = await runReconcileCycle();
    expect(second.participantsProcessed).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.subjectIdentityId).sort()).toEqual([...identities].sort());
  });
});

describe("emit-reconcile: cycle error handling", () => {
  it("stops the cycle on a selection-query error and runs normally on the next cycle", async () => {
    const identity = randomUUID();
    await insertParticipant({ identityId: identity, xp: xpForLevel(5) });

    const { client, calls } = makeFakeSignals();
    enableEmit(client);

    // A selection-query error propagates out of the cycle (the scheduler catches it).
    const failingSelect: SelectBatchFn = async () => {
      throw new Error("simulated selection-query error");
    };
    await expect(runReconcileCycle({ selectBatch: failingSelect })).rejects.toThrow(
      "simulated selection-query error",
    );
    // The failed cycle emitted nothing.
    expect(calls).toHaveLength(0);

    // The next cycle, with the real query, runs normally.
    const result = await runReconcileCycle();
    expect(result.participantsProcessed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subjectIdentityId).toBe(identity);
  });
});

describe("emit-reconcile: config gating", () => {
  it("emits nothing when the emit orchestration is disabled (no runtime override)", async () => {
    // No emit runtime override, so the orchestration falls back to the config flag,
    // which is off in the test env. The pass still iterates the claimed participant,
    // but the orchestration short-circuits to a no-op, so nothing is emitted.
    const identity = randomUUID();
    await insertParticipant({ identityId: identity, xp: xpForLevel(5) });

    const result = await runReconcileCycle();
    expect(result.participantsProcessed).toBe(1);
    // Nothing to assert on a fake here: the orchestration never built a client. The
    // network-level proof lives in the scheduler-gating test (no scheduler starts).
  });
});
