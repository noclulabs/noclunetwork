import { afterEach, describe, expect, it, vi } from "vitest";

// The score client (surface C) exercised against a spied global fetch, with no
// network. getConfig caches after the first call, so each case resets the module
// registry and re-imports a fresh client under stubbed env (the base client needs the
// noclulabs base URL and token set to build a request), mirroring the config tests.
// This is where the on-the-wire acting-for-subject literal is proven: the DB-backed
// summon suite injects a fake ScoreClient, so only this file drives the real query
// builder and the base transport.
describe("score client (surface C)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function load() {
    vi.resetModules();
    vi.stubEnv("NOCLULABS_BASE_URL", "https://noclulabs.test");
    vi.stubEnv("NOCLULABS_SERVICE_TOKEN", "tok-xyz");
    const score = await import("@/lib/noclulabs/score.js");
    return score.scoreClient;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const okBody = {
    subject: "id-123",
    publicScore: { total: 0.4, breakdown: { network: 0.4 } },
    trueScore: { total: 0.9, breakdown: { network: 0.9, verified: true } },
  };

  it("sends actingForSubject as the exact lowercase literal true on the wire", async () => {
    const scoreClient = await load();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(okBody));

    await scoreClient.fetchScore({ subject: "id-123", actingForSubject: "true" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    const url = new URL(calledUrl);
    expect(url.searchParams.get("subject")).toBe("id-123");
    expect(url.searchParams.get("actingForSubject")).toBe("true");
    // The exact lowercase literal, never a capitalized or coerced value.
    expect(calledUrl).toContain("actingForSubject=true");
    expect(calledUrl).not.toContain("actingForSubject=True");
    expect(calledUrl).not.toContain("actingForSubject=TRUE");
  });

  it("sends the lowercase literal false when not acting for the subject", async () => {
    const scoreClient = await load();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ subject: "id-9", publicScore: { total: 0.1, breakdown: {} } }));

    await scoreClient.fetchScore({ subject: "id-9", actingForSubject: "false" });

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get("actingForSubject")).toBe("false");
  });

  it("attaches the bearer token in the Authorization header, never in the URL", async () => {
    const scoreClient = await load();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(okBody));

    await scoreClient.fetchScore({ subject: "id-123", actingForSubject: "true" });

    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).not.toContain("tok-xyz");
    const init = fetchSpy.mock.calls[0]![1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-xyz");
  });

  it("parses a 200 into an ok result, preserving the breakdown passthrough", async () => {
    const scoreClient = await load();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(okBody));

    const result = await scoreClient.fetchScore({ subject: "id-123", actingForSubject: "true" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.subject).toBe("id-123");
    expect(result.publicScore.total).toBe(0.4);
    expect(result.trueScore?.total).toBe(0.9);
    expect(result.trueScore?.breakdown).toEqual({ network: 0.9, verified: true });
  });

  it("returns unknown_subject for a 422 unknown_subject body", async () => {
    const scoreClient = await load();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unknown_subject" }, 422));

    const result = await scoreClient.fetchScore({ subject: "id-x", actingForSubject: "true" });
    expect(result.kind).toBe("unknown_subject");
  });

  it("returns invalid_request for a 422 invalid_request body", async () => {
    const scoreClient = await load();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "invalid_request" }, 422));

    const result = await scoreClient.fetchScore({ subject: "id-x", actingForSubject: "true" });
    expect(result.kind).toBe("invalid_request");
  });

  it("throws a typed unauthorized error for a 401", async () => {
    const scoreClient = await load();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 401));

    await expect(
      scoreClient.fetchScore({ subject: "id-x", actingForSubject: "true" }),
    ).rejects.toMatchObject({ name: "NoclulabsClientError", kind: "unauthorized" });
  });

  it("throws a typed network error when fetch rejects", async () => {
    const scoreClient = await load();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    await expect(
      scoreClient.fetchScore({ subject: "id-x", actingForSubject: "true" }),
    ).rejects.toMatchObject({ name: "NoclulabsClientError", kind: "network" });
  });

  it("throws a network error for a malformed success body (the wire shape is not trusted)", async () => {
    const scoreClient = await load();
    // total is required and must be a number; this body fails the strict parse.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ subject: "id-x", publicScore: { breakdown: {} } }),
    );

    await expect(
      scoreClient.fetchScore({ subject: "id-x", actingForSubject: "true" }),
    ).rejects.toMatchObject({ name: "NoclulabsClientError", kind: "network" });
  });
});
