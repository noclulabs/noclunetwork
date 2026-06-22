import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getConfig } from "@/config.js";
import { fail } from "@/types/envelope.js";

// The bot-facing auth tier. Bots present X-Service-Token plus X-Service-Name.
// This is not user auth; identity and sessions defer to noclulabs.com.
declare module "fastify" {
  interface FastifyInstance {
    authenticateService: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// Timing-safe compare with a length guard. Different lengths short-circuit to
// false without revealing which check failed.
function tokensMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function registerServiceAuth(app: FastifyInstance): void {
  app.decorate(
    "authenticateService",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const rawToken = request.headers["x-service-token"];
      const rawName = request.headers["x-service-name"];
      const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
      const serviceName = Array.isArray(rawName) ? rawName[0] : rawName;

      const expected = getConfig().SERVICE_TOKEN;
      const authorized =
        typeof token === "string" && token.length > 0 && tokensMatch(token, expected);

      if (!authorized) {
        // One message for both the missing and the wrong case.
        void reply.status(401).send(fail("UNAUTHORIZED", "Invalid or missing service token"));
        return;
      }

      request.log.debug({ service: serviceName ?? "unknown" }, "service authenticated");
    },
  );
}
