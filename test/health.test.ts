import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@/server.js";

describe("GET /health", () => {
  let app: FastifyInstance | undefined;

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns 200 with the ok envelope on a cold start with no datastores", async () => {
    app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: { status: "ok" } });
  });
});
