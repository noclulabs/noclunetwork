import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ok } from "@/types/envelope.js";
import { ApiError } from "@/plugins/error-handler.js";
import { PLATFORMS, platformSchema } from "@/lib/registry/platforms.js";
import { isSummonEnabled, summon } from "@/services/summon/summon.js";
import { parseOrThrow } from "./parse.js";

const summonBody = z.object({
  platform: platformSchema,
  platformUserId: z.string().min(1),
});

// A score in the OpenAPI response: a numeric total plus a breakdown surfaced onward
// without depending on its internal shape, so additional properties are allowed and
// serialized as-is (a future noclulabs bucket change must not be stripped).
const scoreObjectSchema = {
  type: "object",
  required: ["total", "breakdown"],
  properties: {
    total: { type: "number" },
    breakdown: { type: "object", additionalProperties: true },
  },
} as const;

// The OpenAPI request and response schemas (the contract noCluBot generates its
// client from). The platform enum is projected from the registry, so the spec cannot
// drift. The route uses attachValidation (below), so this body schema documents the
// contract while the Zod gate enforces it and a malformed body is a 422.
const summonRequestBodySchema = {
  type: "object",
  required: ["platform", "platformUserId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformUserId: { type: "string", minLength: 1 },
  },
} as const;

// The 200 body. The business outcome is a discriminator on data.outcome; the subject
// and the two scores are present only when outcome is "ok".
const summonResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      required: ["outcome"],
      properties: {
        outcome: { type: "string", enum: ["ok", "not_linked", "subject_gone"] },
        // Present only when outcome is "ok".
        subject: { type: "string", format: "uuid" },
        trueScore: scoreObjectSchema,
        publicScore: scoreObjectSchema,
      },
    },
  },
} as const;

export function registerSummonRoutes(app: FastifyInstance): void {
  app.post(
    "/summon",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      // The inbound service-token gate (a bot calling noCluNetwork). Always required,
      // independent of the feature flag. Distinct from the outbound credential
      // (NOCLULABS_SERVICE_TOKEN) the summon presents to noclulabs.com.
      preHandler: [app.authenticateService],
      // Validate-but-do-not-auto-reject: the JSON schema documents the contract for
      // OpenAPI, but a malformed body must be a 422 (surface C's unprocessable-entity
      // semantics), not the framework's default 400. attachValidation routes the AJV
      // result to request.validationError, and the Zod gate below produces the 422.
      attachValidation: true,
      schema: {
        tags: ["summon"],
        summary: "Read an invoking user's noCluID score (the bridge read-down)",
        description:
          "Resolves an invoking platform user to their claimed participant, read-only (never creating a participant), and reads that subject's noCluID score from noclulabs.com surface C, returning the true score and the public score for the bot to present privately. Business outcomes are 200 with a data.outcome discriminator: ok (both scores), not_linked (the user is unknown or an unclaimed ghost), or subject_gone (the noclulabs identity was deleted). Returns 503 summon_disabled when the feature flag is off, 422 for a malformed body, 500 for an internal error, and 502 for an upstream failure. Presentation (ephemeral or DM) is noCluBot's job.",
        security: [{ serviceToken: [] }],
        body: summonRequestBodySchema,
        response: { 200: summonResponseSchema },
      },
    },
    async (request) => {
      // After the inbound auth gate, the feature flag. With it off the endpoint does
      // no resolution and never calls surface C, so merging changes nothing in prod.
      if (!isSummonEnabled()) {
        throw new ApiError("summon_disabled", "Summon is disabled", 503);
      }

      // A malformed body is a 422 here (see attachValidation above), not the 400 the
      // other routes use. The 503 gate above runs first, so a disabled endpoint never
      // parses a body.
      const input = parseOrThrow(summonBody, request.body, 422);

      const outcome = await summon(input);
      switch (outcome.kind) {
        case "ok":
          return ok({
            outcome: "ok",
            subject: outcome.subject,
            trueScore: outcome.trueScore,
            publicScore: outcome.publicScore,
          });
        case "not_linked":
          return ok({ outcome: "not_linked" });
        case "subject_gone":
          return ok({ outcome: "subject_gone" });
        case "internal_error":
          // Our bug (a bad request to surface C) or an unexpected error.
          throw new ApiError("internal", "An internal error occurred resolving the summon", 500);
        case "upstream_error":
          // surface C 401, 500, timeout, or network, or a config failure.
          throw new ApiError("upstream_error", "The identity service could not be reached", 502);
      }
    },
  );
}
