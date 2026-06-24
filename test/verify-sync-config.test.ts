import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// The verify-sync config additions and the scheduler gate. getConfig caches after
// the first call, so each case resets the module registry and re-imports a fresh
// config under stubbed env, mirroring the production-guard config test. DATABASE_URL,
// REDIS_URL, and SERVICE_TOKEN stay set by the vitest env, so only the values under
// test vary.
describe("verify-sync config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults the poller off with the documented defaults when nothing is set", async () => {
    vi.resetModules();
    const { getConfig } = await import("@/config.js");
    const config = getConfig();
    expect(config.VERIFY_SYNC_ENABLED).toBe(false);
    expect(config.VERIFY_SYNC_INTERVAL_MS).toBe(60000);
    expect(config.VERIFY_SYNC_RESCAN_INTERVAL_MS).toBe(3600000);
    expect(config.VERIFY_SYNC_PAGE_SIZE).toBe(200);
    expect(config.NOCLULABS_HTTP_TIMEOUT_MS).toBe(10000);
  });

  it("enables the poller when the flag and the noclulabs credentials are present", async () => {
    vi.resetModules();
    vi.stubEnv("VERIFY_SYNC_ENABLED", "true");
    vi.stubEnv("NOCLULABS_BASE_URL", "https://noclulabs.test");
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", "token-abc");
    const { getConfig } = await import("@/config.js");
    const config = getConfig();
    expect(config.VERIFY_SYNC_ENABLED).toBe(true);
    expect(config.NOCLULABS_BASE_URL).toBe("https://noclulabs.test");
    expect(config.NOCLULABS_SERVICE_TOKEN).toBe("token-abc");
  });

  it("fails fast when the poller is enabled without the base url and token", async () => {
    vi.resetModules();
    vi.stubEnv("VERIFY_SYNC_ENABLED", "true");
    // Both intentionally absent so the optional fields pass and the refine fires.
    vi.stubEnv("NOCLULABS_BASE_URL", undefined);
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", undefined);
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow(/NOCLULABS_BASE_URL or NOCLULABS_SERVICE_TOKEN/);
  });

  it("rejects a non-boolean VERIFY_SYNC_ENABLED", async () => {
    vi.resetModules();
    vi.stubEnv("VERIFY_SYNC_ENABLED", "yes");
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow();
  });

  it("rejects a page size outside the valid range", async () => {
    vi.resetModules();
    vi.stubEnv("VERIFY_SYNC_PAGE_SIZE", "600");
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow();
  });
});

describe("verify-sync scheduler gating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("does not start the scheduler or touch the network when the flag is off", async () => {
    vi.resetModules();
    // The ambient test env leaves VERIFY_SYNC_ENABLED unset (false).
    const { registerVerifySync } = await import("@/plugins/verify-sync.js");

    const addHook = vi.fn();
    const appStub = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      addHook,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    registerVerifySync(appStub as unknown as FastifyInstance);

    // No onReady or onClose hook was registered, so no timers start and no cycle
    // can run. And nothing reached the network.
    expect(addHook).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
