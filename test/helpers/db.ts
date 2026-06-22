import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/index.js";

// Truncate every data-model table between tests for isolation. CASCADE clears the
// foreign-key chains, so each test starts from an empty schema. The migrations
// (and so the tables) are applied once by the global setup.
export async function resetDb(): Promise<void> {
  await getDb().execute(
    sql`truncate table
      participants,
      platform_accounts,
      communities,
      community_platforms,
      community_members,
      moderation_actions
      restart identity cascade`,
  );
}
