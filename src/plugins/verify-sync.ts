import type { FastifyInstance } from "fastify";
import { getConfig } from "@/config.js";
import { claimParticipant } from "@/services/participants/claim.js";
import { verifiedConnectionsClient } from "@/lib/noclulabs/verified-connections.js";
import { dbWatermarkStore } from "@/services/verify-sync/watermark.js";
import { createVerifySyncPoller } from "@/services/verify-sync/poller.js";
import { DISCORD_PROVIDER, DISCORD_VERIFIED_STREAM } from "@/services/verify-sync/streams.js";

// The verify-sync scheduler. It wires the inbound verification poller into the app
// lifecycle: a fast-path incremental cycle on a short interval and a slower full
// re-scan that closes the commit-order gap. The plugin is always registered (so
// the wiring is present and enabling is a single config flip), but it self-gates:
// with VERIFY_SYNC_ENABLED false it starts no timers and touches neither the
// database nor the network. That is what makes merging the feature safe before the
// Discord app and the shared token exist.
//
// Single instance for v1. A Redis advisory lock for multi-instance safety is
// deferred: two concurrent pollers are safe because the claim is idempotent, just
// wasteful, so it is not urgent.
export function registerVerifySync(app: FastifyInstance): void {
  const config = getConfig();

  if (!config.VERIFY_SYNC_ENABLED) {
    app.log.info("verify-sync is disabled; the poller will not start");
    return;
  }

  const stream = DISCORD_VERIFIED_STREAM;
  const intervalMs = config.VERIFY_SYNC_INTERVAL_MS;
  const rescanIntervalMs = config.VERIFY_SYNC_RESCAN_INTERVAL_MS;

  const poller = createVerifySyncPoller({
    client: verifiedConnectionsClient,
    claim: claimParticipant,
    watermarks: dbWatermarkStore,
    logger: app.log,
    provider: DISCORD_PROVIDER,
    stream,
    pageSize: config.VERIFY_SYNC_PAGE_SIZE,
    now: () => new Date(),
  });

  // The recurring fast-path interval, the one-shot kickoff that schedules the first
  // re-scan after honoring the last completion, and the recurring re-scan interval.
  let incrementalTimer: NodeJS.Timeout | undefined;
  let rescanKickoff: NodeJS.Timeout | undefined;
  let rescanTimer: NodeJS.Timeout | undefined;

  // In-flight guards so a slow cycle never piles up: a tick that fires while the
  // previous run of the same kind is still in flight is skipped.
  let incrementalRunning = false;
  let rescanRunning = false;

  // Every tick is wrapped so a thrown cycle is logged and the scheduler keeps
  // running. A single failed cycle must never crash the process or stop future
  // cycles; because the watermark advances page-atomically, a failure leaves it
  // unadvanced and the next tick retries the same work safely.
  const runIncremental = async (): Promise<void> => {
    if (incrementalRunning) {
      return;
    }
    incrementalRunning = true;
    try {
      const result = await poller.runIncrementalCycle();
      if (result.connectionsProcessed > 0) {
        app.log.info({ stream, ...result }, "verify-sync incremental cycle complete");
      }
    } catch (error) {
      app.log.error({ stream, err: error }, "verify-sync incremental cycle failed; will retry");
    } finally {
      incrementalRunning = false;
    }
  };

  const runRescan = async (): Promise<void> => {
    if (rescanRunning) {
      return;
    }
    rescanRunning = true;
    try {
      const result = await poller.runFullRescan();
      app.log.info({ stream, ...result }, "verify-sync full re-scan complete");
    } catch (error) {
      app.log.error({ stream, err: error }, "verify-sync full re-scan failed; will retry");
    } finally {
      rescanRunning = false;
    }
  };

  app.addHook("onReady", async () => {
    app.log.info({ stream, intervalMs, rescanIntervalMs }, "verify-sync starting");

    incrementalTimer = setInterval(() => void runIncremental(), intervalMs);
    // unref so a pending timer never holds the process open at shutdown.
    incrementalTimer.unref();

    // Gate the first re-scan on the last completion so a restart does not reset the
    // re-scan clock: if a full re-scan completed within the interval, wait only the
    // remainder; if it never ran or is overdue, run soon after boot.
    const { fullRescanAt } = await dbWatermarkStore.read(stream);
    const sinceLast = fullRescanAt === null ? null : Date.now() - fullRescanAt.getTime();
    const initialRescanDelay = sinceLast === null ? 0 : Math.max(0, rescanIntervalMs - sinceLast);

    rescanKickoff = setTimeout(() => {
      void runRescan();
      rescanTimer = setInterval(() => void runRescan(), rescanIntervalMs);
      rescanTimer.unref();
    }, initialRescanDelay);
    rescanKickoff.unref();
  });

  app.addHook("onClose", async () => {
    if (incrementalTimer !== undefined) {
      clearInterval(incrementalTimer);
    }
    if (rescanKickoff !== undefined) {
      clearTimeout(rescanKickoff);
    }
    if (rescanTimer !== undefined) {
      clearInterval(rescanTimer);
    }
  });
}
