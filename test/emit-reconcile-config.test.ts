import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// The emit-reconcile config additions and the scheduler gate. getConfig caches after
// the first call, so each case resets the module registry and re-imports a fresh
// config under stubbed env, mirroring the emit-sync config test. DATABASE_URL,
// REDIS_URL, and SERVICE_TOKEN stay set by the vitest env, so only the values under
// test vary.
describe("emit-reconcile config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults the reconcile off with the documented defaults when nothing is set", async () => {
    vi.resetModules();
    const { getConfig } = await import("@/config.js");
    const config = getConfig();
    expect(config.EMIT_RECONCILE_ENABLED).toBe(false);
    expect(config.EMIT_RECONCILE_INTERVAL_MS).toBe(21600000);
    expect(config.EMIT_RECONCILE_BATCH_SIZE).toBe(200);
  });

  it("enables the reconcile when the flag and the noclulabs credentials are present", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_RECONCILE_ENABLED", "true");
    vi.stubEnv("NOCLULABS_BASE_URL", "https://noclulabs.test");
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", "token-abc");
    const { getConfig } = await import("@/config.js");
    const config = getConfig();
    expect(config.EMIT_RECONCILE_ENABLED).toBe(true);
    expect(config.NOCLULABS_BASE_URL).toBe("https://noclulabs.test");
    expect(config.NOCLULABS_SERVICE_TOKEN).toBe("token-abc");
  });

  it("fails fast when the reconcile is enabled without the base url and token", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_RECONCILE_ENABLED", "true");
    // Both intentionally absent so the optional fields pass and the refine fires.
    vi.stubEnv("NOCLULABS_BASE_URL", undefined);
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", undefined);
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow(
      /EMIT_RECONCILE_ENABLED is true but NOCLULABS_BASE_URL or NOCLULABS_SERVICE_TOKEN/,
    );
  });

  it("rejects a non-boolean EMIT_RECONCILE_ENABLED", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_RECONCILE_ENABLED", "yes");
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow();
  });

  it("rejects a batch size outside the valid range", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_RECONCILE_BATCH_SIZE", "2000");
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow();
  });
});

describe("emit-reconcile scheduler gating", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // A minimal Fastify stub that records addHook calls, used to prove the scheduler
  // registers no lifecycle hooks (and so starts no timer) when gated off.
  function makeAppStub() {
    const addHook = vi.fn();
    const app = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      addHook,
    } as unknown as FastifyInstance;
    return { app, addHook };
  }

  it("does not start the scheduler or touch the network when both flags are off", async () => {
    vi.resetModules();
    // The ambient test env leaves both flags unset (false).
    const { registerEmitReconcile } = await import("@/plugins/emit-reconcile.js");
    const { app, addHook } = makeAppStub();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    registerEmitReconcile(app);

    expect(addHook).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not start the scheduler when the reconcile flag is on but the emit flag is off", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_RECONCILE_ENABLED", "true");
    // EMIT_SYNC_ENABLED stays off; credentials present so config still loads.
    vi.stubEnv("NOCLULABS_BASE_URL", "https://noclulabs.test");
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", "token-abc");
    const { registerEmitReconcile } = await import("@/plugins/emit-reconcile.js");
    const { app, addHook } = makeAppStub();

    registerEmitReconcile(app);

    // The reconcile is meaningless without the on-event emit, so it stays inert.
    expect(addHook).not.toHaveBeenCalled();
  });

  it("does not start the scheduler when the emit flag is on but the reconcile flag is off", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_SYNC_ENABLED", "true");
    vi.stubEnv("NOCLULABS_BASE_URL", "https://noclulabs.test");
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", "token-abc");
    const { registerEmitReconcile } = await import("@/plugins/emit-reconcile.js");
    const { app, addHook } = makeAppStub();

    registerEmitReconcile(app);

    expect(addHook).not.toHaveBeenCalled();
  });

  it("registers lifecycle hooks (a timer) only when both flags are on", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_SYNC_ENABLED", "true");
    vi.stubEnv("EMIT_RECONCILE_ENABLED", "true");
    vi.stubEnv("NOCLULABS_BASE_URL", "https://noclulabs.test");
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", "token-abc");
    const { registerEmitReconcile } = await import("@/plugins/emit-reconcile.js");
    const { app, addHook } = makeAppStub();

    registerEmitReconcile(app);

    // onReady (starts the timer) and onClose (clears it) are both registered.
    const hooks = addHook.mock.calls.map((call) => call[0]);
    expect(hooks).toContain("onReady");
    expect(hooks).toContain("onClose");
  });
});
