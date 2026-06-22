import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { communities } from "./communities.js";

// Maps a community to an external platform group (for example a Discord guild).
// platform is validated against the platform registry at the application layer.
// The unique (platform, platform_group_id) makes community resolve idempotent.
export const communityPlatforms = pgTable(
  "community_platforms",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    platformGroupId: text("platform_group_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("community_platforms_platform_platform_group_id_key").on(
      table.platform,
      table.platformGroupId,
    ),
    index("community_platforms_community_id_idx").on(table.communityId),
  ],
);

export type CommunityPlatform = typeof communityPlatforms.$inferSelect;
export type NewCommunityPlatform = typeof communityPlatforms.$inferInsert;
