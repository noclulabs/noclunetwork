import { ApiError } from "@/plugins/error-handler.js";

// The Postgres unique_violation SQLSTATE. node-postgres surfaces it as err.code
// on the thrown DatabaseError. drizzle-orm does not rethrow that error directly:
// it wraps the driver error in a DrizzleQueryError whose own `code` is undefined
// and attaches the DatabaseError as `cause`. So the check walks the cause chain
// (bounded), not just the top-level error, or a lost create race would surface as
// a 500 instead of a re-resolve. The resolve services rely on this for race safety.
const UNIQUE_VIOLATION = "23505";
const MAX_CAUSE_DEPTH = 8;

export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// An insert ... returning() or update ... returning() that the caller knows must
// produce exactly one row. noUncheckedIndexedAccess types rows[0] as possibly
// undefined; this narrows it and fails loud (500) if the row is somehow absent.
export function requireRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new ApiError("INTERNAL_ERROR", `expected a row from ${context}`, 500);
  }
  return row;
}
