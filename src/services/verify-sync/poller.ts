import { isPlatform } from "@/lib/registry/platforms.js";
import { ApiError } from "@/plugins/error-handler.js";
import type { ClaimParticipantInput, ClaimResult } from "@/services/participants/claim.js";
import type {
  VerifiedConnection,
  VerifiedConnectionsClient,
} from "@/lib/noclulabs/verified-connections.js";
import type { WatermarkStore } from "./watermark.js";

// The claim service the poller drives in-process. Injected as a function so a test
// can wrap it (for example to make one row throw a transient error). The plugin
// injects the real claimParticipant; the poller never reimplements claim logic and
// never calls our own HTTP endpoint.
export type ClaimFn = (input: ClaimParticipantInput) => Promise<ClaimResult>;

// A minimal structured logger (Fastify's app.log satisfies it). The poller logs
// anomalies (a conflict, an unregistered platform) without depending on Fastify.
export interface VerifySyncLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface VerifySyncDeps {
  client: VerifiedConnectionsClient;
  claim: ClaimFn;
  watermarks: WatermarkStore;
  logger: VerifySyncLogger;
  // The surface-B provider (a registered platform, for example "discord").
  provider: string;
  // The watermark key for this stream.
  stream: string;
  // The page size requested from surface B.
  pageSize: number;
  // The clock for the full-rescan completion stamp. Injectable so a test is
  // deterministic; the plugin passes () => new Date().
  now: () => Date;
}

// A per-cycle tally, for logging and for assertions in tests.
export interface CycleResult {
  pagesProcessed: number;
  connectionsProcessed: number;
  claimed: number;
  alreadyLinked: number;
  merged: number;
  // The defined conflict outcome (account already verified to a different owner),
  // a data anomaly that does not stall the stream.
  conflicts: number;
  // A row that could not be processed defensively (an unregistered platform),
  // skipped rather than thrown.
  anomalies: number;
}

export interface VerifySyncPoller {
  // The fast path: read the watermark, drain new pages, advance page-atomically.
  runIncrementalCycle(): Promise<CycleResult>;
  // The gap-closure sweep: re-drive every connection from the beginning, never
  // touching the fast-path cursor, then stamp the completion time.
  runFullRescan(): Promise<CycleResult>;
}

function emptyResult(): CycleResult {
  return {
    pagesProcessed: 0,
    connectionsProcessed: 0,
    claimed: 0,
    alreadyLinked: 0,
    merged: 0,
    conflicts: 0,
    anomalies: 0,
  };
}

export function createVerifySyncPoller(deps: VerifySyncDeps): VerifySyncPoller {
  const { client, claim, watermarks, logger, provider, stream, pageSize } = deps;

  // Drive one connection's claim and fold its outcome into the running tally.
  // Normal outcomes (claimed, already_linked, merged) and the two non-fatal
  // anomalies (an unregistered platform, the already-verified conflict) are
  // counted and swallowed so the stream keeps moving. Anything else is rethrown,
  // which stops the cycle without advancing (failure-no-advance).
  async function driveClaim(connection: VerifiedConnection, result: CycleResult): Promise<void> {
    result.connectionsProcessed += 1;

    // Defensive: a row whose provider is not a registered platform cannot be
    // mapped onto a claim. Log and skip it as an anomaly rather than throwing and
    // stalling the whole stream over one bad row.
    if (!isPlatform(connection.provider)) {
      result.anomalies += 1;
      logger.warn(
        { stream, provider: connection.provider, providerAccountId: connection.providerAccountId },
        "verify-sync skipped a connection with an unregistered platform",
      );
      return;
    }

    try {
      const claimResult = await claim({
        platform: connection.provider,
        platformUserId: connection.providerAccountId,
        noclulabsIdentityId: connection.noclulabsIdentityId,
      });
      switch (claimResult.outcome) {
        case "claimed":
          result.claimed += 1;
          break;
        case "already_linked":
          result.alreadyLinked += 1;
          break;
        case "merged":
          result.merged += 1;
          break;
      }
    } catch (error) {
      // The defined conflict outcome: the platform account is already verified to a
      // different owner. noclulabs.com enforces one account to one owner, so this
      // should not occur; if it does it is a data anomaly. Log it with enough
      // detail to investigate, count it, and continue. Do not stall the stream.
      if (error instanceof ApiError && error.code === "ACCOUNT_ALREADY_VERIFIED") {
        result.conflicts += 1;
        logger.warn(
          {
            stream,
            provider: connection.provider,
            providerAccountId: connection.providerAccountId,
            noclulabsIdentityId: connection.noclulabsIdentityId,
          },
          "verify-sync hit an account-already-verified conflict; continuing past it",
        );
        return;
      }
      // An unexpected or transient error (a database error, an exhausted retry, a
      // malformed response): rethrow so the cycle stops without advancing the
      // watermark and retries on the next tick.
      throw error;
    }
  }

  // The shared page-processing loop both modes use. Page from a starting cursor,
  // drive every row in order, and (for the fast path only) advance the watermark
  // after each fully processed page. The advance is page-atomic: a thrown claim
  // propagates out before setCursor runs, so the page's cursor is never persisted
  // and the next cycle re-fetches and re-processes it (idempotent, so free).
  async function consumeStream(
    startCursor: string | null,
    advanceWatermark: boolean,
  ): Promise<CycleResult> {
    const result = emptyResult();
    let cursor = startCursor;

    for (;;) {
      const page = await client.fetch({ provider, since: cursor, limit: pageSize });

      // An empty page is the end. Do not advance (nextCursor is null on an empty
      // page, and persisting null would reset the watermark to the beginning).
      if (page.connections.length === 0) {
        break;
      }

      for (const connection of page.connections) {
        await driveClaim(connection, result);
      }
      result.pagesProcessed += 1;

      // The whole page processed without a thrown error. Advance to its nextCursor.
      cursor = page.nextCursor;
      if (advanceWatermark) {
        await watermarks.setCursor(stream, cursor);
      }

      // A full page means there may be more; a short page is the last one.
      if (page.connections.length < pageSize) {
        break;
      }
    }

    return result;
  }

  return {
    async runIncrementalCycle(): Promise<CycleResult> {
      const { cursor } = await watermarks.read(stream);
      return consumeStream(cursor, true);
    },

    async runFullRescan(): Promise<CycleResult> {
      // The gap-closure sweep. The cursor is replay-safe but not gap-free: a
      // connection id is fixed at insert but visible only at commit, and commit
      // order is not id order, so a lower-id connection that commits after the
      // watermark passed it would be skipped permanently by id > since. A periodic
      // full sweep from the beginning re-drives the idempotent claim for every row
      // and closes that gap. It uses a local cursor and never reads or writes the
      // fast-path watermark cursor; on completion it stamps full_rescan_at.
      const result = await consumeStream(null, false);
      await watermarks.setFullRescanAt(stream, deps.now());
      return result;
    },
  };
}
