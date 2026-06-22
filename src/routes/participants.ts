import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ok } from "@/types/envelope.js";
import { PLATFORMS, platformSchema } from "@/lib/registry/platforms.js";
import { resolveParticipant } from "@/services/participants/resolve.js";
import { claimParticipant } from "@/services/participants/claim.js";
import { parseOrThrow } from "./parse.js";

const resolveBody = z.object({
  platform: platformSchema,
  platformUserId: z.string().min(1),
  platformUsername: z.string().min(1).optional(),
});

const claimBody = z.object({
  platform: platformSchema,
  platformUserId: z.string().min(1),
  noclulabsIdentityId: z.uuid(),
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

// The claim (verification) request and response. The platform enum is projected
// from the registry, like resolve, so the OpenAPI spec cannot drift.
const claimRequestBodySchema = {
  type: "object",
  required: ["platform", "platformUserId", "noclulabsIdentityId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformUserId: { type: "string", minLength: 1 },
    noclulabsIdentityId: { type: "string", format: "uuid" },
  },
} as const;

const claimResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      required: ["participant", "outcome"],
      properties: {
        participant: {
          type: "object",
          required: ["id", "noclulabsIdentityId", "createdAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            // Always set after a claim: every outcome leaves the participant
            // linked to the identity.
            noclulabsIdentityId: { type: "string", format: "uuid" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        outcome: { type: "string", enum: ["claimed", "already_linked", "merged"] },
        // Present only when outcome is "merged": the id of the removed ghost.
        mergedParticipantId: { type: "string", format: "uuid" },
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

  app.post(
    "/participants/claim",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["participants"],
        summary: "Claim a platform account for a noclulabs identity (verification)",
        description:
          "Attaches a verified platform account to its noclulabs identity. Resolve-or-creates the account if unseen, then returns already_linked if it already maps to this identity, 409 if it maps to a different one, claimed if a ghost is linked in place, or merged if a separate participant already holds the identity (the ghost merges into it). Idempotent and concurrency-safe.",
        security: [{ serviceToken: [] }],
        body: claimRequestBodySchema,
        response: { 200: claimResponseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(claimBody, request.body);
      const result = await claimParticipant(input);
      return ok(result);
    },
  );
}
