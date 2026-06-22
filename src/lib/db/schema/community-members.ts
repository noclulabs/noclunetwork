import { sql } from "drizzle-orm";
import { index, integer, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { communities } from "./communities.js";
import { participants } from "./participants.js";

// The join between a participant and a community. Defined now as foundational
// schema; the membership lifecycle (join, leave, roles) is phase 4, so this
// table is intentionally unpopulated in this phase. permission_level is a coarse
// per-community role rank, refined when the lifecycle lands.
export const communityMembers = pgTable(
  "community_members",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    permissionLevel: integer("permission_level").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("community_members_community_id_participant_id_key").on(
      table.communityId,
      table.participantId,
    ),
    index("community_members_community_id_idx").on(table.communityId),
    index("community_members_participant_id_idx").on(table.participantId),
  ],
);

export type CommunityMember = typeof communityMembers.$inferSelect;
export type NewCommunityMember = typeof communityMembers.$inferInsert;
