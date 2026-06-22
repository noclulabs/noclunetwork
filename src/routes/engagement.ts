import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ok } from "@/types/envelope.js";
import { PLATFORMS, platformSchema } from "@/lib/registry/platforms.js";
import { recordEngagement } from "@/services/engagement/grant.js";
import { membershipSchema } from "./memberships.js";
import { parseOrThrow } from "./parse.js";

const engagementBody = z.object({
  platform: platformSchema,
  platformUserId: z.string().min(1),
  platformGroupId: z.string().min(1),
  platformUsername: z.string().min(1).optional(),
});

// The OpenAPI request and response schemas (the contract noCluBot generates its
// client from). The platform enum is projected from the registry, so the spec
// cannot drift from PLATFORMS. networkXp and networkLevel are integers: network_xp
// is a bigint column read in number mode (every reachable XP is far below 2^53),
// and the BigInt-to-Number serialization hook is the general envelope safety net.
const engagementRequestBodySchema = {
  type: "object",
  required: ["platform", "platformUserId", "platformGroupId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformUserId: { type: "string", minLength: 1 },
    platformGroupId: { type: "string", minLength: 1 },
    platformUsername: { type: "string", minLength: 1 },
  },
} as const;

const engagementResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      required: ["participant", "membership", "granted", "leveledUp"],
      properties: {
        participant: {
          type: "object",
          required: ["id", "networkXp", "networkLevel"],
          properties: {
            id: { type: "string", format: "uuid" },
            // The lifetime, network-wide XP total and the level derived from it.
            networkXp: { type: "integer" },
            networkLevel: { type: "integer" },
          },
        },
        membership: membershipSchema,
        // False when the per-community cooldown gated the grant (a no-op).
        granted: { type: "boolean" },
        leveledUp: { type: "boolean" },
        // Present only when leveledUp: the network level before this grant.
        previousLevel: { type: "integer" },
      },
    },
  },
} as const;

export function registerEngagementRoutes(app: FastifyInstance): void {
  app.post(
    "/engagement",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["engagement"],
        summary: "Record an engagement and accrue network XP",
        description:
          "The call a bot makes on a trackable interaction. Ensures the participant, community, and membership exist (reusing the membership path), then accrues lifetime network XP gated by a per-community cooldown. A grant increments network_xp and reports the new total, the derived network level, and any level-up; a call inside the cooldown is a no-op success (granted false) that reports the current total and level.",
        security: [{ serviceToken: [] }],
        body: engagementRequestBodySchema,
        response: { 200: engagementResponseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(engagementBody, request.body);
      const result = await recordEngagement(input);
      return ok(result);
    },
  );
}
