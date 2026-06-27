import { and, eq } from "drizzle-orm";
import pino, { type Logger } from "pino";
import { getConfig } from "@/config.js";
import { getDb } from "@/lib/db/index.js";
import { participants, platformAccounts } from "@/lib/db/schema/index.js";
import type { Platform } from "@/lib/registry/platforms.js";
import { NoclulabsClientError } from "@/lib/noclulabs/client.js";
import { scoreClient, type Score, type ScoreClient } from "@/lib/noclulabs/score.js";

// The summon service: the noCluNetwork side of the bridge's read-down capability. It
// resolves an invoking platform user to their claimed participant, READ-ONLY (never
// creating a participant), and reads that subject's noCluID score from noclulabs.com
// surface C, returning the true score and the public score for the bot to present.
//
// Unlike the emit (which is best-effort and swallows every error), the summon is
// synchronous and user-facing, so it does not swallow failures; it maps every case to
// a defined outcome the route renders. The defined business outcomes (ok, not_linked,
// subject_gone) are 200 with a discriminator; infrastructure and upstream failures
// (internal_error, upstream_error) are surfaced loudly so a failure never masquerades
// as a normal result.
//
// Read-only by design: the summon never writes participant state, including on
// subject_gone (a deleted noclulabs.com subject). The emit path remains the authority
// for the identity_emit_disabled_at stale-link marker and self-heals on its next
// emit, so the summon stays a clean read.

const ACTING_FOR_SUBJECT_SELF = "true" as const;

export interface SummonInput {
  platform: Platform;
  platformUserId: string;
}

// The typed outcome. The route maps each to a status and body.
export type SummonOutcome =
  // The subject was resolved and both scores were read (from one surface C call).
  | { kind: "ok"; subject: string; trueScore: Score; publicScore: Score }
  // No platform account, or an unclaimed ghost (no noclulabs identity). The two
  // sub-cases are unified here and distinguished only in the log.
  | { kind: "not_linked" }
  // surface C reported the subject is gone (unknown_subject): the identity was deleted
  // on noclulabs.com. Distinct from not_linked.
  | { kind: "subject_gone" }
  // Our bug: surface C reported invalid_request (we built a bad request), or an
  // unexpected error. The route renders this as a 500.
  | { kind: "internal_error" }
  // A transport, auth, or server error reaching surface C (401, 500, timeout, or
  // network). The route renders this as a 502.
  | { kind: "upstream_error" };

// A minimal structured logger for the not_linked sub-case (observability) and the
// error outcomes. Mirrors the emit-sync logger seam.
export interface SummonLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

// The injectable runtime. Production uses the real score client and the config flag;
// the test seam replaces the client (and enables, and silences the logger) so the
// suite drives the real service and route fully offline.
export interface SummonRuntime {
  client: ScoreClient;
  enabled: boolean;
  logger: SummonLogger;
}

let testOverrides: Partial<SummonRuntime> | undefined;

let fallbackLoggerInstance: Logger | undefined;
function fallbackLogger(): SummonLogger {
  fallbackLoggerInstance ??= pino({ name: "summon", level: getConfig().LOG_LEVEL });
  return fallbackLoggerInstance;
}

function resolveClient(): ScoreClient {
  return testOverrides?.client ?? scoreClient;
}
function resolveLogger(): SummonLogger {
  return testOverrides?.logger ?? fallbackLogger();
}

// Whether the summon endpoint is enabled. The route calls this to short-circuit with
// 503 before any resolution, so a disabled endpoint never resolves and never calls
// surface C. Resolved on its own (and first) so the disabled path is a pure no-op.
export function isSummonEnabled(): boolean {
  return testOverrides?.enabled ?? getConfig().SUMMON_ENABLED;
}

// Test-only seam: inject a fake ScoreClient (and optionally enable it, or a silent
// logger) so the suite exercises the real service and route with no network.
// Production never calls this; the defaults are the real client and the SUMMON_ENABLED
// config flag.
export function setSummonRuntimeForTest(overrides: Partial<SummonRuntime>): void {
  testOverrides = overrides;
}
export function resetSummonRuntimeForTest(): void {
  testOverrides = undefined;
}

// Read-only lookup of a platform account and its participant by (platform,
// platformUserId). Never creates anything (this is NOT the resolve-or-create path).
// Returns the participant's id and noclulabs identity id, or undefined if the account
// has never been seen.
async function findClaimedSubject(
  platform: string,
  platformUserId: string,
): Promise<{ participantId: string; identityId: string | null } | undefined> {
  const rows = await getDb()
    .select({
      participantId: participants.id,
      identityId: participants.noclulabsIdentityId,
    })
    .from(platformAccounts)
    .innerJoin(participants, eq(participants.id, platformAccounts.participantId))
    .where(
      and(
        eq(platformAccounts.platform, platform),
        eq(platformAccounts.platformUserId, platformUserId),
      ),
    )
    .limit(1);
  return rows[0];
}

// Resolve an invoking platform user to their score. Assumes the feature is enabled
// (the route short-circuits to 503 when it is not). Read-only throughout.
export async function summon(input: SummonInput): Promise<SummonOutcome> {
  const { platform, platformUserId } = input;
  const logger = resolveLogger();

  const found = await findClaimedSubject(platform, platformUserId);

  // Unify the two not_linked sub-cases, logging which occurred for observability.
  if (found === undefined) {
    logger.info({ platform, platformUserId }, "summon not_linked: platform account never seen");
    return { kind: "not_linked" };
  }
  if (found.identityId === null) {
    logger.info(
      { platform, platformUserId, participantId: found.participantId },
      "summon not_linked: participant is an unclaimed ghost",
    );
    return { kind: "not_linked" };
  }

  const subject = found.identityId;

  let result;
  try {
    // The invoking user IS the subject, so request the true score (the route is per
    // the privacy contract: the true score is owner-only and returned only for the
    // authenticated subject about themselves).
    result = await resolveClient().fetchScore({ subject, actingForSubject: ACTING_FOR_SUBJECT_SELF });
  } catch (error) {
    if (error instanceof NoclulabsClientError) {
      // 401, 500, any other non-2xx, a network error or timeout: an upstream or
      // config failure, not our request bug.
      logger.warn(
        { platform, platformUserId, subject, kind: error.kind },
        "summon upstream error reading surface C",
      );
      return { kind: "upstream_error" };
    }
    // An unexpected error (for example a bug in our own resolution). Surface loudly.
    logger.error(
      { platform, platformUserId, subject, err: error },
      "summon unexpected error reading surface C",
    );
    return { kind: "internal_error" };
  }

  switch (result.kind) {
    case "ok": {
      // We always send actingForSubject "true", so surface C must return the true
      // score; its absence is an upstream contract violation, surfaced as upstream.
      if (result.trueScore === undefined) {
        logger.warn(
          { platform, platformUserId, subject },
          "summon ok from surface C without a true score despite actingForSubject true",
        );
        return { kind: "upstream_error" };
      }
      return {
        kind: "ok",
        subject: result.subject,
        trueScore: result.trueScore,
        publicScore: result.publicScore,
      };
    }
    case "unknown_subject":
      // The identity was deleted on noclulabs.com. Read-only: never write participant
      // state here. The emit path owns the stale-link marker and self-heals.
      logger.warn(
        { platform, platformUserId, subject },
        "summon subject_gone: surface C reported unknown_subject (a stale noclulabs link)",
      );
      return { kind: "subject_gone" };
    case "invalid_request":
      // We built a bad request to surface C: our bug, rendered as a 500.
      logger.error(
        { platform, platformUserId, subject },
        "summon received invalid_request from surface C (a request bug on our side)",
      );
      return { kind: "internal_error" };
  }
}
