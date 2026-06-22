import { ApiError } from "@/plugins/error-handler.js";

// Postgres SQLSTATE codes. node-postgres surfaces them as err.code on the thrown
// DatabaseError. drizzle-orm does not rethrow that error directly: it wraps the
// driver error in a DrizzleQueryError whose own `code` is undefined and attaches
// the DatabaseError as `cause`. So the checks below walk the cause chain (bounded),
// not just the top-level error, or a lost race would surface as a 500 instead of a
// retry. The resolve and claim services rely on this for race safety.
const UNIQUE_VIOLATION = "23505";
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";
const MAX_CAUSE_DEPTH = 8;

// Walk the bounded cause chain for a thrown error and report whether any link
// carries one of the given SQLSTATE codes.
function hasSqlState(error: unknown, codes: ReadonlySet<string>): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && codes.has(code)) {
        return true;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const UNIQUE_VIOLATION_CODES: ReadonlySet<string> = new Set([UNIQUE_VIOLATION]);
const RETRYABLE_TRANSACTION_CODES: ReadonlySet<string> = new Set([
  SERIALIZATION_FAILURE,
  DEADLOCK_DETECTED,
]);

export function isUniqueViolation(error: unknown): boolean {
  return hasSqlState(error, UNIQUE_VIOLATION_CODES);
}

// A transient transaction error Postgres resolves by re-running the whole
// transaction: a serialization failure or a detected deadlock. In both cases the
// transaction has already rolled back, so the caller can safely retry from the
// top. The claim-and-merge retry loop uses this so an unlucky concurrent claim
// retries instead of returning a 500.
export function isRetryableTransactionError(error: unknown): boolean {
  return hasSqlState(error, RETRYABLE_TRANSACTION_CODES);
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
