import type { FastifyInstance } from "fastify";
import { getConfig } from "@/config.js";
import { runReconcileCycle } from "@/services/emit-sync/reconcile.js";

// The emit reconcile scheduler. It wires the stateless reconcile pass into the app
// lifecycle: a single recurring full pass on a slow interval that re-emits every
// claimed participant's current contribution through the existing emit
// orchestration. The plugin is always registered (so the wiring is present and
// enabling is a single config flip), but it self-gates: it starts a timer only when
// BOTH EMIT_SYNC_ENABLED and EMIT_RECONCILE_ENABLED are true. The reconcile is
// meaningless without the on-event emit (it re-emits through the same orchestration
// and the same signals client), so the emit flag gates it too. Either flag off and
// the plugin registers and does nothing: no timer, no database, no network. That is
// what makes merging the feature safe before the shared token and the private base
// URL exist, and it is why the test environment (both flags off) never starts it.
//
// Single instance for v1. Multi-instance coordination is deferred: two concurrent
// reconciles are safe because the emit is idempotent (the server conditionally
// appends and dedups an unchanged value), just wasteful, so an advisory lock is not
// urgent.
export function registerEmitReconcile(app: FastifyInstance): void {
  const config = getConfig();

  if (!config.EMIT_SYNC_ENABLED || !config.EMIT_RECONCILE_ENABLED) {
    app.log.info("emit-reconcile is disabled; the reconcile will not start");
    return;
  }

  const intervalMs = config.EMIT_RECONCILE_INTERVAL_MS;

  let timer: NodeJS.Timeout | undefined;
  // In-flight guard so a slow pass never piles up: a tick that fires while the
  // previous pass is still running is skipped.
  let running = false;

  // Every cycle is wrapped so a thrown pass is logged and the scheduler keeps
  // running. A single failed cycle (a selection-query or database error) must never
  // crash the process or stop future cycles; the pass is stateless, so the next
  // interval simply retries from the beginning.
  const runCycle = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await runReconcileCycle();
      app.log.info({ ...result }, "emit-reconcile cycle complete");
    } catch (error) {
      app.log.error({ err: error }, "emit-reconcile cycle failed; will retry");
    } finally {
      running = false;
    }
  };

  app.addHook("onReady", async () => {
    app.log.info({ intervalMs }, "emit-reconcile starting");
    timer = setInterval(() => void runCycle(), intervalMs);
    // unref so a pending timer never holds the process open at shutdown.
    timer.unref();
  });

  app.addHook("onClose", async () => {
    if (timer !== undefined) {
      clearInterval(timer);
    }
  });
}
