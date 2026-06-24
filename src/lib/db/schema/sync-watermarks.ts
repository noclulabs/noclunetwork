import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// The durable cursor state for the inbound verify-sync poller (phase 5, the bridge
// verify capability). One row per stream (for example noclulabs:verified:discord).
//
// The watermark must survive restarts, so it lives in Postgres, not Redis. The
// single ncn: Redis namespace is reserved for the engagement cooldown and is
// untouched by the poller. Keying by stream lets another platform slot in later
// with no schema change.
//
// cursor is the last consumed connection id (a uuidv7 carried as text, since it is
// noclulabs.com's id and never compared as a local uuid); null means start from
// the beginning. The fast-path incremental cycle advances it page-atomically.
//
// full_rescan_at records when the last full gap-closure re-scan completed. The
// scheduler reads it on start to gate the re-scan cadence across restarts (a
// restart does not reset the re-scan clock). The full re-scan never touches the
// fast-path cursor; it only stamps this column.
//
// NOT participant-owned: there is no foreign key to participants, so this table is
// intentionally absent from the participant-owned-relations list, and the catalog
// assertion (which covers only tables that cascade off participants) is unaffected.
export const syncWatermarks = pgTable("sync_watermarks", {
  stream: text("stream").primaryKey(),
  cursor: text("cursor"),
  fullRescanAt: timestamp("full_rescan_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SyncWatermark = typeof syncWatermarks.$inferSelect;
export type NewSyncWatermark = typeof syncWatermarks.$inferInsert;
