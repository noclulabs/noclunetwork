import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getConfig } from "@/config.js";

const { Pool } = pg;

// Lazily initialized: importing this module has no side effects, the pool is
// built on first use, and an unset DATABASE_URL throws then, not at import.
let poolInstance: pg.Pool | undefined;
let dbInstance: NodePgDatabase | undefined;

export function getPool(): pg.Pool {
  if (!poolInstance) {
    poolInstance = new Pool({ connectionString: getConfig().DATABASE_URL });
  }
  return poolInstance;
}

// The preferred handle for queries.
export function getDb(): NodePgDatabase {
  if (!dbInstance) {
    dbInstance = drizzle(getPool());
  }
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = undefined;
    dbInstance = undefined;
  }
}
