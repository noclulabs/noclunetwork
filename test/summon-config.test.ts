import { afterEach, describe, expect, it, vi } from "vitest";

// The summon config addition and the enable refine. getConfig caches after the first
// call, so each case resets the module registry and re-imports a fresh config under
// stubbed env, mirroring the emit-sync and verify-sync config tests. DATABASE_URL,
// REDIS_URL, and SERVICE_TOKEN stay set by the vitest env, so only the values under
// test vary.
describe("summon config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults the summon endpoint off when nothing is set", async () => {
    vi.resetModules();
    const { getConfig } = await import("@/config.js");
    expect(getConfig().SUMMON_ENABLED).toBe(false);
  });

  it("enables the summon when the flag and the noclulabs credentials are present", async () => {
    vi.resetModules();
    vi.stubEnv("SUMMON_ENABLED", "true");
    vi.stubEnv("NOCLULABS_BASE_URL", "https://noclulabs.test");
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", "token-abc");
    const { getConfig } = await import("@/config.js");
    const config = getConfig();
    expect(config.SUMMON_ENABLED).toBe(true);
    expect(config.NOCLULABS_BASE_URL).toBe("https://noclulabs.test");
    expect(config.NOCLULABS_SERVICE_TOKEN).toBe("token-abc");
  });

  it("fails fast when the summon is enabled without the base url and token", async () => {
    vi.resetModules();
    vi.stubEnv("SUMMON_ENABLED", "true");
    // Both intentionally absent so the optional fields pass and the refine fires.
    vi.stubEnv("NOCLULABS_BASE_URL", undefined);
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", undefined);
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow(
      /SUMMON_ENABLED is true but NOCLULABS_BASE_URL or NOCLULABS_SERVICE_TOKEN/,
    );
  });

  it("rejects a non-boolean SUMMON_ENABLED", async () => {
    vi.resetModules();
    vi.stubEnv("SUMMON_ENABLED", "yes");
    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow();
  });
});
