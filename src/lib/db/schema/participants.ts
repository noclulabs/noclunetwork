import { sql } from "drizzle-orm";
import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

// The spine. A local person record with no auth fields. noCluNetwork keys
// platform accounts to this record; it never mints users and stores no
// credentials. noclulabs_identity_id is the cross-system link to a noCluID
// identity on noclulabs.com: null means a ghost (auto-created from platform
// activity, not yet verified). There is deliberately no foreign key, since that
// id lives in another system; integrity is maintained by the verification flow
// in later phases. The unique constraint permits many null rows, because
// Postgres treats nulls as distinct.
export const participants = pgTable("participants", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  noclulabsIdentityId: uuid("noclulabs_identity_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Participant = typeof participants.$inferSelect;
export type NewParticipant = typeof participants.$inferInsert;
