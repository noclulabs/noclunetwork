import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getPool } from "@/lib/db/index.js";
import { PARTICIPANT_OWNED_RELATIONS } from "@/services/participants/owned-relations.js";

// The fail-loud safety net for the merge. A participant-owned table (one with a
// foreign key to participants, ON DELETE CASCADE) that is not registered in
// PARTICIPANT_OWNED_RELATIONS, OR a participant foreign-key column that is not
// declared in its entry, would be silently dropped when a ghost is deleted in a
// merge: the relocation never moves it and the USER_HAS_DATA guard never counts
// it. This test introspects the Postgres catalog for every (table, column) whose
// foreign key references participants and asserts each table is registered and
// each column is declared, so a future owned table OR a future second column
// (moderation_actions is the first table with two) added without registration
// fails this test rather than dropping rows in production. It is a test, not a
// boot-time check, to keep the lazy-connection invariant (the app must boot
// without touching the database).

afterAll(async () => {
  await closeDb();
});

describe("participant-owned relations catalog", () => {
  it("registers every table and every column with a foreign key to participants", async () => {
    const result = await getPool().query<{ table_name: string; column_name: string }>(
      `select child.relname as table_name, att.attname as column_name
         from pg_constraint c
         join pg_class child on child.oid = c.conrelid
         join pg_class parent on parent.oid = c.confrelid
         join lateral unnest(c.conkey) as colnum on true
         join pg_attribute att on att.attrelid = c.conrelid and att.attnum = colnum
        where c.contype = 'f' and parent.relname = 'participants'`,
    );

    // Group the catalog's participant foreign-key columns by table.
    const catalogColumns = new Map<string, Set<string>>();
    for (const row of result.rows) {
      const columns = catalogColumns.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      catalogColumns.set(row.table_name, columns);
    }

    const registeredColumns = new Map<string, Set<string>>(
      PARTICIPANT_OWNED_RELATIONS.map((relation) => [
        relation.name,
        new Set(relation.participantColumns),
      ]),
    );

    // Sanity: the query actually found the known owned tables (a query that
    // returned nothing would pass the checks below vacuously), including the first
    // table with two participant foreign keys.
    expect([...catalogColumns.keys()].sort()).toEqual(
      expect.arrayContaining(["community_members", "moderation_actions", "platform_accounts"]),
    );
    expect([...(catalogColumns.get("moderation_actions") ?? [])].sort()).toEqual([
      "actor_participant_id",
      "target_participant_id",
    ]);

    // The guarantee: every table that cascades off participants is registered, and
    // its declared participant columns exactly match the catalog, so the merge
    // relocates every column and the guard covers it.
    for (const [table, columns] of catalogColumns) {
      const declared = registeredColumns.get(table);
      expect(declared, `table ${table} is not registered in PARTICIPANT_OWNED_RELATIONS`).toBeDefined();
      expect([...columns].sort(), `participant columns for ${table} drifted from the registry`).toEqual(
        [...(declared ?? new Set<string>())].sort(),
      );
    }
  });
});
