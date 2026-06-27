import { afterEach, describe, expect, it, vi } from "vitest";

// The emit-sync config additions and the enable refine. getConfig caches after the
// first call, so each case resets the module registry and re-imports a fresh config
// under stubbed env, mirroring the verify-sync config test. DATABASE_URL, REDIS_URL,
// and SERVICE_TOKEN stay set by the vitest env, so only the values under test vary.
describe("emit-sync config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults the emit client off when nothing is set", async () => {
    vi.resetModules();
    const { getConfig } = await import("@/config.js");
    expect(getConfig().EMIT_SYNC_ENABLED).toBe(false);
  });

  it("enables the emit client when the flag and the noclulabs credentials are present", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_SYNC_ENABLED", "true");
    vi.stubEnv("NOCLULABS_BASE_URL", "https://noclulabs.test");
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", "token-abc");
    const { getConfig } = await import("@/config.js");
    const config = getConfig();
    expect(config.EMIT_SYNC_ENABLED).toBe(true);
    expect(config.NOCLULABS_BASE_URL).toBe("https://noclulabs.test");
    expect(config.NOCLULABS_SERVICE_TOKEN).toBe("token-abc");
  });

  it("fails fast when the emit client is enabled without the base url and token", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_SYNC_ENABLED", "true");
    // Both intentionally absent so the optional fields pass and the refine fires.
    vi.stubEnv("NOCLULABS_BASE_URL", undefined);
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", undefined);
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow(/EMIT_SYNC_ENABLED is true but NOCLULABS_BASE_URL or NOCLULABS_SERVICE_TOKEN/);
  });

  it("rejects a non-boolean EMIT_SYNC_ENABLED", async () => {
    vi.resetModules();
    vi.stubEnv("EMIT_SYNC_ENABLED", "yes");
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow();
  });
});
