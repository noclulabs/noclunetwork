import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { TEST_DATABASE_URL } from "./constants.js";

// A guard before interpolating the database name into CREATE DATABASE, which
// cannot be parameterized. The test database name is a known constant; this only
// fails loud if a future URL carries something unexpected.
const DB_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

// Connect to the maintenance database and create the target test database if it
// does not exist. CI provisions noclunetwork_test as a service, but local
// docker-compose.dev only creates noclunetwork, so the harness creates the test
// database on first run.
async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!DB_NAME_PATTERN.test(dbName)) {
    throw new Error(`refusing to create a database with an unexpected name: ${dbName}`);
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
    if (existing.rowCount === 0) {
      await admin.query(`create database "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
}

// Runs once before the suite (in the vitest main process): ensure the test
// database exists, then apply the migrations so the migration itself is exercised
// on every run. The migrator is idempotent, so reruns against an already-migrated
// database are a no-op.
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? TEST_DATABASE_URL;
  await ensureDatabaseExists(url);

  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "drizzle/migrations" });
  } finally {
    await pool.end();
  }
}
