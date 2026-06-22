import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ok } from "@/types/envelope.js";
import { PLATFORMS, platformSchema } from "@/lib/registry/platforms.js";
import { ensureMembership, leaveMembership } from "@/services/memberships/lifecycle.js";
import { parseOrThrow } from "./parse.js";

const ensureBody = z.object({
  platform: platformSchema,
  platformUserId: z.string().min(1),
  platformGroupId: z.string().min(1),
  platformUsername: z.string().min(1).optional(),
  communityName: z.string().min(1).optional(),
});

const leaveBody = z.object({
  platform: platformSchema,
  platformUserId: z.string().min(1),
  platformGroupId: z.string().min(1),
});

// The membership view shared by both responses. The platform enums in the request
// schemas are projected from the registry, so the OpenAPI spec cannot drift.
const membershipSchema = {
  type: "object",
  required: ["id", "communityId", "participantId", "active", "permissionLevel", "createdAt", "leftAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    communityId: { type: "string", format: "uuid" },
    participantId: { type: "string", format: "uuid" },
    active: { type: "boolean" },
    permissionLevel: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    leftAt: { type: "string", format: "date-time", nullable: true },
  },
} as const;

const ensureRequestBodySchema = {
  type: "object",
  required: ["platform", "platformUserId", "platformGroupId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformUserId: { type: "string", minLength: 1 },
    platformGroupId: { type: "string", minLength: 1 },
    platformUsername: { type: "string", minLength: 1 },
    communityName: { type: "string", minLength: 1 },
  },
} as const;

const ensureResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      required: ["participant", "community", "membership", "created", "reactivated"],
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
        community: {
          type: "object",
          required: ["id", "name", "createdAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        membership: membershipSchema,
        created: { type: "boolean" },
        reactivated: { type: "boolean" },
      },
    },
  },
} as const;

const leaveRequestBodySchema = {
  type: "object",
  required: ["platform", "platformUserId", "platformGroupId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformUserId: { type: "string", minLength: 1 },
    platformGroupId: { type: "string", minLength: 1 },
  },
} as const;

const leaveResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      required: ["left", "membership"],
      properties: {
        left: { type: "boolean" },
        // Null when there was nothing to leave (no membership row).
        membership: { ...membershipSchema, nullable: true },
      },
    },
  },
} as const;

export function registerMembershipRoutes(app: FastifyInstance): void {
  app.post(
    "/memberships/ensure",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["memberships"],
        summary: "Ensure a participant is a member of a community",
        description:
          "Resolve-or-creates the participant (a ghost if new) and the community (from the platform group), then ensures the membership. Creates it if absent (active, permission level 0), reactivates it if a prior leave left it inactive (preserving created_at and permission level), or no-ops if already active. Idempotent and concurrency-safe.",
        security: [{ serviceToken: [] }],
        body: ensureRequestBodySchema,
        response: { 200: ensureResponseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(ensureBody, request.body);
      const result = await ensureMembership(input);
      return ok(result);
    },
  );

  app.post(
    "/memberships/leave",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["memberships"],
        summary: "Leave a community (soft leave)",
        description:
          "Resolves the participant and community without creating them, then marks an active membership inactive (left_at set). Leaving an absent participant, community, or membership, or an already-inactive membership, is an idempotent no-op success (left false).",
        security: [{ serviceToken: [] }],
        body: leaveRequestBodySchema,
        response: { 200: leaveResponseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(leaveBody, request.body);
      const result = await leaveMembership(input);
      return ok(result);
    },
  );
}
