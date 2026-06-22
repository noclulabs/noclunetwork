import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { participants } from "./participants.js";

// A platform identity (a Discord user, for example) linked to a participant,
// many-to-one. platform is free-form text validated against the platform
// registry at the application layer (registry-as-canonical, no Postgres enum).
// verified is whether this link has been confirmed through a noCluID connection;
// ghosts are false. The unique (platform, platform_user_id) makes resolve idempotent.
export const platformAccounts = pgTable(
  "platform_accounts",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    platformUserId: text("platform_user_id").notNull(),
    platformUsername: text("platform_username"),
    isPrimary: boolean("is_primary").notNull().default(false),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("platform_accounts_platform_platform_user_id_key").on(
      table.platform,
      table.platformUserId,
    ),
    index("platform_accounts_participant_id_idx").on(table.participantId),
  ],
);

export type PlatformAccount = typeof platformAccounts.$inferSelect;
export type NewPlatformAccount = typeof platformAccounts.$inferInsert;
