import type { ZodType } from "zod";
import { ApiError } from "@/plugins/error-handler.js";

// Parse a request payload with a Zod schema, throwing an ApiError (rendered into
// the response envelope by the error handler) on failure. The route JSON schemas
// validate the shape at the edge for the OpenAPI contract; this is the typed,
// registry-backed domain gate that hands the service a narrowed value. statusCode
// defaults to 400 (the convention for every route); the summon endpoint passes 422
// because it deals in noclulabs.com surface C's unprocessable-entity semantics.
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, statusCode = 400): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
      .join("; ");
    throw new ApiError("VALIDATION_ERROR", message, statusCode);
  }
  return result.data;
}
