import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { communities } from "./communities.js";
import { participants } from "./participants.js";

// The append-only moderation log (phase 4c). Each row records one moderation
// event in a community: who acted (actor), on whom (target), what action, why,
// and when. The derived sanction state (muted, banned) is computed at read from
// this log and never stored.
//
// This is a ledger, like the signal stream: rows are content-immutable. The table
// deliberately carries no updated_at and no set_updated_at trigger (the pattern
// every other table follows), and there is no update or delete route. The only
// writes are inserts (the moderation action route) and the participant
// foreign-key re-point during a merge, which follows a unified identity without
// changing what the row records.
//
// action is free-form text validated against the moderation action registry at
// the application layer (registry-as-canonical, no Postgres enum), mirroring how
// platform is validated against the platform registry.
//
// expires_at is set for a temporary mute or ban (now plus the requested duration)
// and null for a permanent action or one with no duration. The derived sanction
// state reads it to decide whether a mute or ban is still active.
//
// PARTICIPANT-OWNED, with TWO foreign keys to participants (actor and target),
// both ON DELETE CASCADE. This table MUST be registered in the participant-owned
// relations list with BOTH columns re-pointed on a merge, or a merge would
// silently drop a ghost's log rows (the cascade) and the guard would trip. See
// src/services/participants/owned-relations.ts.
export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    actorParticipantId: uuid("actor_participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    targetParticipantId: uuid("target_participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Serves the per-member sanction-state query (filter by target and community,
    // newest first) and the merge lookup by target (the leading column).
    index("moderation_actions_target_community_created_idx").on(
      table.targetParticipantId,
      table.communityId,
      table.createdAt.desc(),
    ),
    // The merge lookup by actor.
    index("moderation_actions_actor_participant_id_idx").on(table.actorParticipantId),
    // Community-wide history, newest first.
    index("moderation_actions_community_created_idx").on(
      table.communityId,
      table.createdAt.desc(),
    ),
  ],
);

export type ModerationAction = typeof moderationActions.$inferSelect;
export type NewModerationAction = typeof moderationActions.$inferInsert;
