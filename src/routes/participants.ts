import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ok } from "@/types/envelope.js";
import { PLATFORMS, platformSchema } from "@/lib/registry/platforms.js";
import { resolveParticipant } from "@/services/participants/resolve.js";
import { parseOrThrow } from "./parse.js";

const resolveBody = z.object({
  platform: platformSchema,
  platformUserId: z.string().min(1),
  platformUsername: z.string().min(1).optional(),
});

// The OpenAPI request and response schemas (the contract noCluBot generates its
// client from). The platform enum is projected from the registry, so the spec
// cannot drift from PLATFORMS.
const requestBodySchema = {
  type: "object",
  required: ["platform", "platformUserId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformUserId: { type: "string", minLength: 1 },
    platformUsername: { type: "string", minLength: 1 },
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      required: ["participant", "platformAccount", "created"],
      properties: {
        participant: {
          type: "object",
          required: ["id", "noclulabsIdentityId", "createdAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            noclulabsIdentityId: { type: "string", format: "uuid", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        platformAccount: {
          type: "object",
          required: ["id", "platform", "platformUserId", "verified", "isPrimary"],
          properties: {
            id: { type: "string", format: "uuid" },
            platform: { type: "string" },
            platformUserId: { type: "string" },
            verified: { type: "boolean" },
            isPrimary: { type: "boolean" },
          },
        },
        created: { type: "boolean" },
      },
    },
  },
} as const;

export function registerParticipantRoutes(app: FastifyInstance): void {
  app.post(
    "/participants/resolve",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["participants"],
        summary: "Resolve or create a participant from a platform user id",
        description:
          "Idempotent on (platform, platformUserId). Returns the existing participant and platform account, or creates a ghost participant (noclulabsIdentityId null) and its first platform account.",
        security: [{ serviceToken: [] }],
        body: requestBodySchema,
        response: { 200: responseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(resolveBody, request.body);
      const resolved = await resolveParticipant(input);
      return ok(resolved);
    },
  );
}
