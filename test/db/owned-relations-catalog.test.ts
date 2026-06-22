import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getPool } from "@/lib/db/index.js";
import { PARTICIPANT_OWNED_RELATIONS } from "@/services/participants/owned-relations.js";

// The fail-loud safety net for the merge. A participant-owned table (one with a
// participant_id foreign key, ON DELETE CASCADE) that is not registered in
// PARTICIPANT_OWNED_RELATIONS would be silently dropped when a ghost is deleted in
// a merge: the relocation never moves it and the USER_HAS_DATA guard never counts
// it. This test introspects the Postgres catalog for every table whose foreign key
// references participants and asserts each is registered, so a future owned table
// added without registration fails this test rather than dropping rows in
// production. It is a test, not a boot-time check, to keep the lazy-connection
// invariant (the app must boot without touching the database).

afterAll(async () => {
  await closeDb();
});

describe("participant-owned relations catalog", () => {
  it("registers every table with a foreign key to participants", async () => {
    const result = await getPool().query<{ table_name: string }>(
      `select distinct child.relname as table_name
         from pg_constraint c
         join pg_class child on child.oid = c.conrelid
         join pg_class parent on parent.oid = c.confrelid
        where c.contype = 'f' and parent.relname = 'participants'`,
    );
    const foreignKeyTables = result.rows.map((row) => row.table_name).sort();
    const registered = PARTICIPANT_OWNED_RELATIONS.map((relation) => relation.name).sort();

    // Sanity: the query actually found the known owned tables (a query that
    // returned nothing would pass the subset check vacuously).
    expect(foreignKeyTables).toContain("platform_accounts");
    expect(foreignKeyTables).toContain("community_members");

    // The guarantee: every table that cascades off participants is registered, so
    // the merge relocates it and the guard covers it.
    for (const table of foreignKeyTables) {
      expect(registered).toContain(table);
    }
  });
});
