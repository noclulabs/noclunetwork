import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ok } from "@/types/envelope.js";
import { PLATFORMS, platformSchema } from "@/lib/registry/platforms.js";
import { resolveCommunity } from "@/services/communities/resolve.js";
import { parseOrThrow } from "./parse.js";

const resolveBody = z.object({
  platform: platformSchema,
  platformGroupId: z.string().min(1),
  name: z.string().min(1).optional(),
});

const requestBodySchema = {
  type: "object",
  required: ["platform", "platformGroupId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformGroupId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      required: ["community", "communityPlatform", "created"],
      properties: {
        community: {
          type: "object",
          required: ["id", "name", "createdAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        communityPlatform: {
          type: "object",
          required: ["id", "platform", "platformGroupId"],
          properties: {
            id: { type: "string", format: "uuid" },
            platform: { type: "string" },
            platformGroupId: { type: "string" },
          },
        },
        created: { type: "boolean" },
      },
    },
  },
} as const;

export function registerCommunityRoutes(app: FastifyInstance): void {
  app.post(
    "/communities/resolve",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["communities"],
        summary: "Resolve or create a community from a platform group id",
        description:
          "Idempotent on (platform, platformGroupId). Returns the existing community and platform mapping, or creates a community (the given name, or a placeholder) and its platform mapping.",
        security: [{ serviceToken: [] }],
        body: requestBodySchema,
        response: { 200: responseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(resolveBody, request.body);
      const resolved = await resolveCommunity(input);
      return ok(resolved);
    },
  );
}
