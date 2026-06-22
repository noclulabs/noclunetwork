import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// A platform-agnostic community. One community can span several platform groups
// (a Discord guild plus, later, a Telegram group) through community_platforms.
export const communities = pgTable("communities", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Community = typeof communities.$inferSelect;
export type NewCommunity = typeof communities.$inferInsert;
