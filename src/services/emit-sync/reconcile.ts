import { and, asc, gt, isNotNull, isNull } from "drizzle-orm";
import { getConfig } from "@/config.js";
import { getDb } from "@/lib/db/index.js";
import { participants } from "@/lib/db/schema/index.js";
import { emitParticipantContribution } from "./emit.js";

// The emit reconcile backstop: a stateless full pass that re-emits every claimed,
// non-stale participant's current leveling contribution through the existing emit
// orchestration. It closes the two gaps the on-event emit cannot cover: an emit
// lost while noclulabs.com was unreachable, and a crash between a committed
// transaction and its best-effort emit.
//
// It reimplements nothing. It calls emitParticipantContribution (the same
// orchestration the on-event path uses), which derives the value from the existing
// trueScoreContribution, owns the skip checks (ghost, missing, stale link), owns the
// stale-link marker, and swallows every emit error. The pass adds only the
// iteration: select claimed participants in keyset-paginated batches and run the
// orchestration on each.
//
// Why a full re-emit rather than tracking which participants are stale: the server
// conditionally appends, writing a new ledger row only when the incoming value
// differs, so re-emitting a participant who is already current writes nothing and
// returns written false. A full pass is therefore cheap on the ledger and
// self-correcting, and it needs no per-participant bookkeeping on the hot path. The
// cost is one request per claimed participant per cycle, acceptable on a slow
// cadence over the private network. A windowed or throttled pass is a noted future
// optimization, not part of this slice.
//
// observedAt: the orchestration stamps observedAt from its own clock (the current
// time by default), which is correct here. The reconcile observes the participant's
// current standing now, so now is the right observedAt, and that is exactly what the
// orchestration uses.

// One id from the selection query. The orchestration re-selects the full row
// itself, so the pass only needs the keyset id.
interface ParticipantId {
  id: string;
}

// The selection-query seam, injectable so a test can drive pagination with a small
// batch and simulate a query-level error. The default reads claimed, non-stale
// participants from the real database.
export type SelectBatchFn = (
  afterId: string | null,
  limit: number,
) => Promise<ParticipantId[]>;

export interface RunReconcileCycleOptions {
  // The keyset page size. Defaults to EMIT_RECONCILE_BATCH_SIZE.
  batchSize?: number;
  // The per-participant emit. Defaults to the real orchestration. Injectable so a
  // test can assert exactly which participants were fed to the orchestration
  // (proving the query-level skips), independent of the orchestration's own checks.
  emit?: (participantId: string) => Promise<void>;
  // The batch loader. Defaults to the real keyset query. Injectable so a test can
  // simulate a selection-query error that stops the cycle.
  selectBatch?: SelectBatchFn;
}

// A per-cycle tally, for logging and for assertions in tests.
export interface ReconcileResult {
  participantsProcessed: number;
  batches: number;
}

// The default selection query: claimed (noclulabs_identity_id not null) and
// non-stale (identity_emit_disabled_at null) participants, ordered by id ascending
// and keyset-paginated by id > afterId with a row limit. Filtering at the query
// keeps obvious skips (ghosts and confirmed stale links) out of the pass; the
// orchestration's own internal checks remain the authority for each row it sees.
async function selectClaimedNonStaleBatch(
  afterId: string | null,
  limit: number,
): Promise<ParticipantId[]> {
  const claimedAndFresh = and(
    isNotNull(participants.noclulabsIdentityId),
    isNull(participants.identityEmitDisabledAt),
  );
  const where = afterId === null ? claimedAndFresh : and(claimedAndFresh, gt(participants.id, afterId));

  return getDb()
    .select({ id: participants.id })
    .from(participants)
    .where(where)
    .orderBy(asc(participants.id))
    .limit(limit);
}

// Run one full reconcile pass. Keyset-paginate through claimed, non-stale
// participants and run the emit orchestration on each, in bounded batches, never
// loading all participants at once.
//
// Best-effort per participant: emitParticipantContribution never throws, so one
// participant's failed emit (a transport error, a thrown client outcome) does not
// stop the pass. A selection-query or database error from selectBatch propagates out
// and stops the cycle; the scheduler logs it and the next interval retries from the
// beginning (the pass is stateless, so there is nothing to roll back).
//
// Stale-marker safety during a pass: if the orchestration sets the stale marker on a
// participant that returns unknown_subject, that participant has already been passed
// in this forward keyset scan (the cursor only moves forward), so it is not revisited
// this cycle, and the next cycle's selection query excludes it. There is no loop and
// no double processing.
export async function runReconcileCycle(
  options: RunReconcileCycleOptions = {},
): Promise<ReconcileResult> {
  const batchSize = options.batchSize ?? getConfig().EMIT_RECONCILE_BATCH_SIZE;
  const emit = options.emit ?? emitParticipantContribution;
  const selectBatch = options.selectBatch ?? selectClaimedNonStaleBatch;

  let cursor: string | null = null;
  let participantsProcessed = 0;
  let batches = 0;

  for (;;) {
    const batch = await selectBatch(cursor, batchSize);
    if (batch.length === 0) {
      break;
    }

    for (const row of batch) {
      // Best-effort: the orchestration swallows its own errors, so this never
      // throws and one participant cannot stop the pass.
      await emit(row.id);
      participantsProcessed += 1;
    }
    batches += 1;

    // Advance the keyset cursor to the last id of the batch. The next batch starts
    // strictly after it (id > cursor), so each participant is processed once.
    cursor = batch[batch.length - 1]!.id;

    // A short page is the last one; a full page means there may be more.
    if (batch.length < batchSize) {
      break;
    }
  }

  return { participantsProcessed, batches };
}
