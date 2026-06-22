import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ok } from "@/types/envelope.js";
import { PLATFORMS, platformSchema } from "@/lib/registry/platforms.js";
import { MODERATION_ACTIONS, moderationActionSchema } from "@/lib/registry/moderation-actions.js";
import {
  MAX_DURATION_SECONDS,
  MAX_REASON_LENGTH,
  recordModerationAction,
} from "@/services/moderation/actions.js";
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  getModerationHistory,
  getSanctionState,
} from "@/services/moderation/sanction-state.js";
import { parseOrThrow } from "./parse.js";

// The action route body. platform is validated against the platform registry and
// action against the moderation action registry (an unknown value is a 400).
// reason is bounded text; durationSeconds, when present, must be a positive
// integer within a sane bound (zero, negative, fractional, or absurd is a 400).
const actionBody = z.object({
  platform: platformSchema,
  platformGroupId: z.string().min(1),
  actorPlatformUserId: z.string().min(1),
  targetPlatformUserId: z.string().min(1),
  action: moderationActionSchema,
  reason: z.string().min(1).max(MAX_REASON_LENGTH).optional(),
  durationSeconds: z.number().int().positive().max(MAX_DURATION_SECONDS).optional(),
});

// The shared query for both reads: which member in which community. Resolved
// without creating anything.
const memberQuery = z.object({
  platform: platformSchema,
  platformGroupId: z.string().min(1),
  platformUserId: z.string().min(1),
});

// The history query adds pagination. Query values arrive as strings, so coerce;
// page is 1-based and pageSize is bounded.
const historyQuery = memberQuery.extend({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_HISTORY_PAGE_SIZE)
    .default(DEFAULT_HISTORY_PAGE_SIZE),
});

// The OpenAPI shape of one moderation_actions row (the contract noCluBot
// generates its client from). The action enum is projected from the registry, so
// the spec cannot drift from MODERATION_ACTIONS. reason and expiresAt are
// nullable; expiresAt is set only for a timed mute or ban.
const moderationActionViewSchema = {
  type: "object",
  required: [
    "id",
    "communityId",
    "actorParticipantId",
    "targetParticipantId",
    "action",
    "reason",
    "expiresAt",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    communityId: { type: "string", format: "uuid" },
    actorParticipantId: { type: "string", format: "uuid" },
    targetParticipantId: { type: "string", format: "uuid" },
    action: { type: "string", enum: [...MODERATION_ACTIONS] },
    reason: { type: "string", nullable: true },
    expiresAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

// The derived sanction state. until values are the active sanction's expiry when
// it is timed, null for an indefinite or absent sanction.
const sanctionStateSchema = {
  type: "object",
  required: ["muted", "mutedUntil", "banned", "bannedUntil"],
  properties: {
    muted: { type: "boolean" },
    mutedUntil: { type: "string", format: "date-time", nullable: true },
    banned: { type: "boolean" },
    bannedUntil: { type: "string", format: "date-time", nullable: true },
  },
} as const;

const actionRequestBodySchema = {
  type: "object",
  required: ["platform", "platformGroupId", "actorPlatformUserId", "targetPlatformUserId", "action"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformGroupId: { type: "string", minLength: 1 },
    actorPlatformUserId: { type: "string", minLength: 1 },
    targetPlatformUserId: { type: "string", minLength: 1 },
    action: { type: "string", enum: [...MODERATION_ACTIONS] },
    reason: { type: "string", minLength: 1, maxLength: MAX_REASON_LENGTH },
    durationSeconds: { type: "integer", minimum: 1, maximum: MAX_DURATION_SECONDS },
  },
} as const;

const actionResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: {
      type: "object",
      required: ["action", "sanctionState"],
      properties: {
        action: moderationActionViewSchema,
        sanctionState: sanctionStateSchema,
      },
    },
  },
} as const;

const memberQuerySchema = {
  type: "object",
  required: ["platform", "platformGroupId", "platformUserId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformGroupId: { type: "string", minLength: 1 },
    platformUserId: { type: "string", minLength: 1 },
  },
} as const;

const stateResponseSchema = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { type: "boolean" },
    data: sanctionStateSchema,
  },
} as const;

const historyQuerySchema = {
  type: "object",
  required: ["platform", "platformGroupId", "platformUserId"],
  additionalProperties: false,
  properties: {
    platform: { type: "string", enum: [...PLATFORMS] },
    platformGroupId: { type: "string", minLength: 1 },
    platformUserId: { type: "string", minLength: 1 },
    page: { type: "integer", minimum: 1, default: 1 },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: MAX_HISTORY_PAGE_SIZE,
      default: DEFAULT_HISTORY_PAGE_SIZE,
    },
  },
} as const;

const historyResponseSchema = {
  type: "object",
  required: ["success", "data", "pagination"],
  properties: {
    success: { type: "boolean" },
    data: { type: "array", items: moderationActionViewSchema },
    pagination: {
      type: "object",
      required: ["page", "pageSize", "total"],
      properties: {
        page: { type: "integer" },
        pageSize: { type: "integer" },
        total: { type: "integer" },
      },
    },
  },
} as const;

export function registerModerationRoutes(app: FastifyInstance): void {
  app.post(
    "/moderation/actions",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["moderation"],
        summary: "Record a moderation action and apply its effect",
        description:
          "Appends one event to the append-only moderation log and applies its membership effect, then returns the recorded action and the target's resulting derived sanction state. warn logs only; mute or unmute toggle the muted state (a duration sets an expiry); kick soft-leaves any membership with no lasting sanction; ban soft-leaves any membership and sets the banned state (a duration sets an expiry); unban clears the banned state without rejoining. The community, actor, and target are resolve-or-created, so a ban can target a non-member. Native moderator authorization is the bot's responsibility; the core records the reported actor.",
        security: [{ serviceToken: [] }],
        body: actionRequestBodySchema,
        response: { 200: actionResponseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(actionBody, request.body);
      const result = await recordModerationAction(input);
      return ok(result);
    },
  );

  app.get(
    "/moderation/state",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["moderation"],
        summary: "Read a member's current sanction state",
        description:
          "Resolves (platform, platformGroupId, platformUserId) without creating anything and returns the derived sanction state (muted, mutedUntil, banned, bannedUntil) computed from the log. A member or community that does not exist returns the cleared state.",
        security: [{ serviceToken: [] }],
        querystring: memberQuerySchema,
        response: { 200: stateResponseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(memberQuery, request.query);
      const state = await getSanctionState(input);
      return ok(state);
    },
  );

  app.get(
    "/moderation/history",
    {
      // Trusted service tier: not throttled by the global public limiter.
      config: { rateLimit: false },
      preHandler: [app.authenticateService],
      schema: {
        tags: ["moderation"],
        summary: "Read a member's moderation history (paginated)",
        description:
          "Resolves (platform, platformGroupId, platformUserId) without creating anything and returns that member's moderation actions (where they are the target) in the community, newest first, paginated. page is 1-based; pageSize is bounded. A member or community that does not exist returns an empty page.",
        security: [{ serviceToken: [] }],
        querystring: historyQuerySchema,
        response: { 200: historyResponseSchema },
      },
    },
    async (request) => {
      const input = parseOrThrow(historyQuery, request.query);
      const result = await getModerationHistory(input);
      return ok(result.actions, {
        page: input.page,
        pageSize: input.pageSize,
        total: result.total,
      });
    },
  );
}
