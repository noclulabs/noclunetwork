import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@/server.js";
import { ok } from "@/types/envelope.js";

// SERVICE_TOKEN is set to "test-service-token" by the vitest env config.
const CORRECT_TOKEN = "test-service-token";

describe("authenticateService", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    // A test-only protected route exercising the decorator.
    app.get(
      "/__protected",
      { preHandler: [app.authenticateService] },
      () => ok({ ok: true }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 401 with no token", async () => {
    const response = await app.inject({ method: "GET", url: "/__protected" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 with a wrong token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__protected",
      headers: { "x-service-token": "wrong-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ success: false });
  });

  it("passes with the correct token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__protected",
      headers: {
        "x-service-token": CORRECT_TOKEN,
        "x-service-name": "test-bot",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: { ok: true } });
  });
});
