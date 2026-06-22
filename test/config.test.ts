import { afterEach, describe, expect, it, vi } from "vitest";

// The production DATABASE_URL suffix guard. getConfig caches after the first call,
// so each case resets the module registry and re-imports a fresh config module
// under stubbed env. REDIS_URL and SERVICE_TOKEN stay set by the vitest env, so
// only the guard under test varies.
describe("getConfig production DATABASE_URL guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("fails fast in production when the libpq compatibility suffix is missing", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@db.example.com:5432/noclunetwork");

    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).toThrow(/uselibpqcompat=true/);
  });

  it("passes in production when the suffix is present", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://user:pass@db.example.com:5432/noclunetwork?sslmode=require&uselibpqcompat=true",
    );

    const { getConfig } = await import("@/config.js");
    const config = getConfig();
    expect(config.NODE_ENV).toBe("production");
    expect(config.DATABASE_URL).toContain("uselibpqcompat=true");
  });

  it("does not require the suffix outside production", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgres://noclu:noclu@localhost:5433/noclunetwork");

    const { getConfig } = await import("@/config.js");
    expect(() => getConfig()).not.toThrow();
  });
});
