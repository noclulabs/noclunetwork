import { sql } from "drizzle-orm";
import { bigint, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

// The spine. A local person record with no auth fields. noCluNetwork keys
// platform accounts to this record; it never mints users and stores no
// credentials. noclulabs_identity_id is the cross-system link to a noCluID
// identity on noclulabs.com: null means a ghost (auto-created from platform
// activity, not yet verified). There is deliberately no foreign key, since that
// id lives in another system; integrity is maintained by the verification flow
// in later phases. The unique constraint permits many null rows, because
// Postgres treats nulls as distinct.
//
// network_xp is the participant's lifetime experience total across the whole
// internet of communities (account-wide, never per-community in this slice). It
// is an append-only running total that only ever grows, so the column is bigint:
// it holds the full range, so the lifetime, uncapped model never overflows at the
// storage layer. The level and the True-Score contribution are DERIVED from it at
// read by the leveling module and are never stored. noCluNetwork stores this
// engagement count and computes a contribution value; it never computes or stores
// a True Score (that lives on noclulabs.com). Drizzle reads it in number mode:
// the leveling curve is floating-point (Math.pow), and every reachable XP is far
// below Number.MAX_SAFE_INTEGER (2^53), so a JS number is exact here. Number mode
// also keeps a plain integer default (0) that drizzle-kit can serialize, where a
// bigint-literal default cannot be.
export const participants = pgTable("participants", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  noclulabsIdentityId: uuid("noclulabs_identity_id").unique(),
  networkXp: bigint("network_xp", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Participant = typeof participants.$inferSelect;
export type NewParticipant = typeof participants.$inferInsert;
