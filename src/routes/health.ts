import type { FastifyInstance } from "fastify";
import { ok } from "@/types/envelope.js";

// Liveness probe. No external dependencies; always 200 when the process is up.
// Readiness checks that ping Postgres and Redis are a later addition.
export function registerHealthRoute(app: FastifyInstance): void {
  app.get(
    "/health",
    {
      // Liveness probes must never be throttled by the global rate limiter.
      config: { rateLimit: false },
      schema: {
        tags: ["system"],
        summary: "Liveness probe",
        description:
          "Returns 200 when the process is up. Does not touch external dependencies.",
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  status: { type: "string" },
                },
                required: ["status"],
              },
            },
            required: ["success", "data"],
          },
        },
      },
    },
    () => ok({ status: "ok" }),
  );
}
