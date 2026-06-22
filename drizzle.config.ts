import { defineConfig } from "drizzle-kit";

// Schema lives in one file per table under src/lib/db/schema and is re-exported
// from its index. Migrations are append-only under drizzle/migrations. The first
// migration lands in the data-model phase and is hand-edited to prepend the
// citext and pgcrypto extensions and the set_updated_at trigger.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema",
  out: "./drizzle/migrations",
  dbCredentials: {
    // The production DATABASE_URL must carry the &uselibpqcompat=true suffix.
    url: process.env.DATABASE_URL ?? "",
  },
});
