import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/index.js";
import { requireRow } from "@/lib/db/helpers.js";
import { syncWatermarks } from "@/lib/db/schema/index.js";

// The durable cursor state for one stream. cursor is the last consumed connection
// id (null means start from the beginning); fullRescanAt is when the last full
// re-scan completed (null means never).
export interface WatermarkState {
  cursor: string | null;
  fullRescanAt: Date | null;
}

// The watermark store the poller depends on. Backed by the sync_watermarks table
// so state survives restarts. The poller takes this interface, so a test can
// substitute a store if it wants; the default is the Postgres-backed store below.
export interface WatermarkStore {
  // Read a stream's watermark, creating the row on first use.
  read(stream: string): Promise<WatermarkState>;
  // Advance (or reset) the fast-path cursor. The full re-scan never calls this.
  setCursor(stream: string, cursor: string | null): Promise<void>;
  // Record a completed full re-scan, used to gate the re-scan cadence.
  setFullRescanAt(stream: string, at: Date): Promise<void>;
}

async function selectRow(stream: string): Promise<WatermarkState | undefined> {
  const row = (
    await getDb()
      .select({ cursor: syncWatermarks.cursor, fullRescanAt: syncWatermarks.fullRescanAt })
      .from(syncWatermarks)
      .where(eq(syncWatermarks.stream, stream))
      .limit(1)
  )[0];
  return row;
}

export const dbWatermarkStore: WatermarkStore = {
  async read(stream: string): Promise<WatermarkState> {
    const existing = await selectRow(stream);
    if (existing !== undefined) {
      return existing;
    }
    // First use: create the row. ON CONFLICT DO NOTHING absorbs a race with a
    // concurrent first read (two cycles starting together), after which the
    // re-read below returns the row the other writer created.
    await getDb().insert(syncWatermarks).values({ stream }).onConflictDoNothing();
    return requireRow(
      await getDb()
        .select({ cursor: syncWatermarks.cursor, fullRescanAt: syncWatermarks.fullRescanAt })
        .from(syncWatermarks)
        .where(eq(syncWatermarks.stream, stream))
        .limit(1),
      "read sync_watermarks after first-use insert",
    );
  },

  async setCursor(stream: string, cursor: string | null): Promise<void> {
    // Upsert: create the row if it is missing, else advance the cursor. The
    // BEFORE UPDATE trigger maintains updated_at on the conflict path.
    await getDb()
      .insert(syncWatermarks)
      .values({ stream, cursor })
      .onConflictDoUpdate({ target: syncWatermarks.stream, set: { cursor } });
  },

  async setFullRescanAt(stream: string, at: Date): Promise<void> {
    await getDb()
      .insert(syncWatermarks)
      .values({ stream, fullRescanAt: at })
      .onConflictDoUpdate({ target: syncWatermarks.stream, set: { fullRescanAt: at } });
  },
};
