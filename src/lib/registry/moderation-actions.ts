import { z } from "zod";

// The moderation action registry: the canonical, app-layer source of valid
// moderation actions, per registry-as-canonical (no Postgres enum, no metadata
// table). The moderation_actions table stores action as free-form text; this
// registry is the integrity boundary, validating the action field on the
// moderation route. Adding an action later is a one-line change to
// MODERATION_ACTIONS.
//
// The name MODERATION_ACTIONS (and the derived type ModerationActionName) is the
// set of valid action NAMES, kept distinct from the moderation_actions row type
// (ModerationAction, the schema's inferred select type), which is a stored row.
export const MODERATION_ACTIONS = ["warn", "mute", "unmute", "kick", "ban", "unban"] as const;

export type ModerationActionName = (typeof MODERATION_ACTIONS)[number];

export const moderationActionSchema = z.enum(MODERATION_ACTIONS);

export function isModerationAction(value: string): value is ModerationActionName {
  return (MODERATION_ACTIONS as readonly string[]).includes(value);
}
