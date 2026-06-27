import { eq } from "drizzle-orm";
import pino, { type Logger } from "pino";
import { getConfig } from "@/config.js";
import { getDb } from "@/lib/db/index.js";
import { participants } from "@/lib/db/schema/index.js";
import { trueScoreContribution } from "@/lib/leveling/index.js";
import { signalsClient, type SignalsClient } from "@/lib/noclulabs/signals.js";

// The emit orchestration: turn a participant into one best-effort signal emit to
// noclulabs.com surface A (the signal intake). It is the noCluNetwork side of the
// bridge's emit capability. It NEVER reimplements the leveling math (it calls the
// existing trueScoreContribution) and NEVER throws into its caller: every emit is
// post-commit and best-effort, so a failed emit cannot endanger the XP gain, the
// claim, the merge, or a poller cycle. The only state it may change is setting the
// stale-link marker on an unknown_subject outcome.

// The signal type for the leveling contribution on surface A. value is
// min(level, 50) / 50, which is exactly what trueScoreContribution returns.
export const NETWORK_LEVEL_SIGNAL_TYPE = "network.level";

// A minimal structured logger for the swallowed best-effort errors and the two
// non-success outcomes. The poller passes Fastify's app.log; here the orchestration
// is called from deep inside request handlers and the poller, so it uses a lazily
// built module logger by default (and a silent one injected in tests).
export interface EmitSyncLogger {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

// The injectable runtime. Production uses the real signals client and the config
// flag; the test seam below replaces the client (and enables, and silences the
// logger) so the suite drives the real orchestration fully offline.
export interface EmitRuntime {
  client: SignalsClient;
  enabled: boolean;
  now: () => Date;
  logger: EmitSyncLogger;
}

let testOverrides: Partial<EmitRuntime> | undefined;

let fallbackLoggerInstance: Logger | undefined;
function fallbackLogger(): EmitSyncLogger {
  fallbackLoggerInstance ??= pino({ name: "emit-sync", level: getConfig().LOG_LEVEL });
  return fallbackLoggerInstance;
}

// enabled is resolved on its own (and first), so the disabled path never builds the
// fallback logger or touches the client: a disabled emit is a pure no-op.
function emitEnabled(): boolean {
  return testOverrides?.enabled ?? getConfig().EMIT_SYNC_ENABLED;
}
function resolveClient(): SignalsClient {
  return testOverrides?.client ?? signalsClient;
}
function resolveNow(): () => Date {
  return testOverrides?.now ?? (() => new Date());
}
function resolveLogger(): EmitSyncLogger {
  return testOverrides?.logger ?? fallbackLogger();
}

// Test-only seam: inject a fake SignalsClient (and optionally enable it, a fixed
// clock, or a silent logger) so the suite exercises the real orchestration with no
// network. Production never calls this; the defaults are the real client and the
// EMIT_SYNC_ENABLED config flag.
export function setEmitRuntimeForTest(overrides: Partial<EmitRuntime>): void {
  testOverrides = overrides;
}
export function resetEmitRuntimeForTest(): void {
  testOverrides = undefined;
}

// Emit a participant's current leveling contribution to surface A, best-effort.
// Given a participant id, it:
//   1. does nothing if the emit is disabled,
//   2. does nothing for a missing participant (a merged ghost), a ghost (no
//      noclulabs subject), or a confirmed stale link (the marker is set),
//   3. derives the value from the existing trueScoreContribution (network_xp ->
//      level -> min(level, 50) / 50),
//   4. POSTs it, and on unknown_subject sets the stale-link marker so the subject
//      never emits again.
// Every failure is swallowed (logged), so this never throws into its caller.
export async function emitParticipantContribution(participantId: string): Promise<void> {
  if (!emitEnabled()) {
    return;
  }

  const client = resolveClient();
  const now = resolveNow();
  const logger = resolveLogger();

  try {
    const participant = (
      await getDb()
        .select({
          id: participants.id,
          noclulabsIdentityId: participants.noclulabsIdentityId,
          networkXp: participants.networkXp,
          identityEmitDisabledAt: participants.identityEmitDisabledAt,
        })
        .from(participants)
        .where(eq(participants.id, participantId))
        .limit(1)
    )[0];

    // The participant may be gone (a merged ghost) by the time this post-commit
    // emit runs; there is nothing to emit for.
    if (participant === undefined) {
      return;
    }
    // A ghost has no noclulabs subject to emit for.
    if (participant.noclulabsIdentityId === null) {
      return;
    }
    // A confirmed stale link: a prior emit returned unknown_subject. Never emit again.
    if (participant.identityEmitDisabledAt !== null) {
      return;
    }

    const at = now();
    const value = trueScoreContribution(participant.networkXp);
    const result = await client.emit({
      subjectIdentityId: participant.noclulabsIdentityId,
      signalType: NETWORK_LEVEL_SIGNAL_TYPE,
      value,
      observedAt: at.toISOString(),
    });

    switch (result.kind) {
      case "unknown_subject":
        // The subject was deleted on noclulabs.com. Set the marker so this subject
        // never emits again. This is the only state the orchestration may change.
        await getDb()
          .update(participants)
          .set({ identityEmitDisabledAt: at })
          .where(eq(participants.id, participantId));
        logger.warn(
          { participantId, subjectIdentityId: participant.noclulabsIdentityId },
          "emit-sync disabled a participant after unknown_subject (a stale noclulabs link)",
        );
        break;
      case "invalid_request":
        // A bug in our request, NOT a stale link. Log it; do not set the marker.
        logger.warn(
          { participantId, value },
          "emit-sync received invalid_request from surface A (a request bug, not a stale link)",
        );
        break;
      case "written":
        // Success. written false is an unchanged-value no-op (the conditional
        // append on noclulabs.com). Nothing to persist.
        break;
    }
  } catch (error) {
    // Best-effort: an emit must never fail the triggering operation. Swallow every
    // error (a transport error, a thrown client outcome, a database error) after
    // logging it; the next triggering event re-emits.
    logger.error({ participantId, err: error }, "emit-sync emit failed; swallowed (best-effort)");
  }
}
