import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { communities } from "./communities.js";
import { participants } from "./participants.js";

// The join between a participant and a community. The membership lifecycle
// (phase 4a) gives this table its write path: ensure-membership and leave.
// permission_level is a coarse per-community role rank, defaulted to 0 here and
// interpreted by moderation (phase 4c). active is the soft-leave flag: true means
// a current member, false means they have left; the row is preserved across a
// leave so a later rejoin reactivates it (keeping created_at and permission_level).
// left_at records when the membership last went inactive and is null while active.
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
    active: boolean("active").notNull().default(true),
    leftAt: timestamp("left_at", { withTimezone: true }),
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
