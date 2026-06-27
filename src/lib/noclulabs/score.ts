import { z } from "zod";
import { NoclulabsClientError, noclulabsGetReadable, type QueryParams } from "./client.js";

// Surface C of the locked v3 bridge contract, as built and live on noclulabs.com:
//
//   GET /api/identity/score   (bearer-gated)
//
// Query:
//   subject (required)            the participant's noclulabs_identity_id (a uuid)
//   actingForSubject (optional)   the exact lowercase literal "true" or "false";
//                                 "true" returns the true score, "false" or omission
//                                 returns the public score only. Any non-canonical
//                                 value (for example "True", "1", "") is rejected 422.
//
// Responses we model:
//   200 { subject, publicScore, trueScore? }   each score is { total, breakdown }.
//                                              publicScore is always present;
//                                              trueScore is present only when
//                                              actingForSubject was "true".
//   422 { error: "unknown_subject" }           the subject is missing or soft-deleted
//   422 { error: "invalid_request" }           a malformed subject or non-canonical
//                                              actingForSubject (our request bug)
//   401                                        a bad token (thrown by the base client)
//   500 server_misconfigured                   remote env unset (thrown by the base)
//
// The two 422s mean different things, mirroring surface A. unknown_subject is a stale
// link (the noclulabs.com user was deleted). invalid_request is a bug in our request.
// We surface each as a distinct outcome so the summon service maps them differently.

const SCORE_PATH = "/api/identity/score";

// The 422 status carries a meaningful application body we must inspect, so the GET
// returns it rather than mapping it to a thrown transport error. Every other non-2xx
// (401, 500, anything else) stays a thrown NoclulabsClientError.
const READABLE_STATUSES: ReadonlySet<number> = new Set([422]);

// A score: a numeric total we depend on, plus a breakdown we surface onward but do
// not depend on the internal shape of, so a future noclulabs bucket change does not
// break our parse. breakdown is validated as a present object (a record of string
// keys to anything) and passed through verbatim; total is validated strictly.
const scoreSchema = z.object({
  total: z.number(),
  breakdown: z.record(z.string(), z.unknown()),
});

// 200 body. Validate strictly what we depend on (subject and each score's total) and
// leniently on the breakdown passthrough. Unknown top-level keys are stripped
// (forward-compatible with additive contract changes).
const successSchema = z.object({
  subject: z.string().min(1),
  publicScore: scoreSchema,
  trueScore: scoreSchema.optional(),
});

// 422 body. The error discriminant (unknown_subject or invalid_request).
const errorSchema = z.object({ error: z.string() });

export type Score = z.infer<typeof scoreSchema>;

export interface FetchScoreParams {
  // The participant's noclulabs_identity_id (a uuid).
  subject: string;
  // The exact lowercase wire literal, typed as a union so a coerced or capitalized
  // boolean cannot be passed (surface C rejects a non-canonical value like "True"
  // with 422). Making the wire value a type-level literal is the guard against an
  // accidental String(boolean) or template serialization. The summon always sends
  // "true" (the invoking user is the subject themselves).
  actingForSubject: "true" | "false";
}

// The typed outcome of a score read. Transport, auth, and server errors (401, 500,
// any other non-2xx, a network error or timeout) are thrown as NoclulabsClientError
// by the base client and are NOT part of this union; the summon service catches them
// and maps them to an upstream error. The two 422 outcomes are returned, not thrown,
// because the caller acts on each differently.
export type ScoreResult =
  // 200: both scores read. trueScore is present because the summon always sends
  // actingForSubject "true"; it is optional in the type because the client is generic
  // over the contract (a "false" read returns publicScore only).
  | { kind: "ok"; subject: string; publicScore: Score; trueScore?: Score }
  // 422 unknown_subject: the noclulabs.com subject is missing or soft-deleted.
  | { kind: "unknown_subject" }
  // 422 invalid_request: our request was malformed. A bug to fix, NOT a stale link.
  | { kind: "invalid_request" };

// The port the summon service depends on, so the test path injects a fake and
// touches no network. fetchScore reads one subject's score from surface C and returns
// the typed outcome.
export interface ScoreClient {
  fetchScore(params: FetchScoreParams): Promise<ScoreResult>;
}

// The real client: build the query, call surface C through the readable-status GET,
// and validate the response before returning a typed outcome. The wire shape is not
// trusted; a body that fails validation is a malformed response (a network-kind
// error). actingForSubject reaches the query as the literal passed in, never built
// from String(boolean) or a template, so a non-canonical value can never be sent.
export const scoreClient: ScoreClient = {
  async fetchScore({ subject, actingForSubject }: FetchScoreParams): Promise<ScoreResult> {
    const query: QueryParams = { subject, actingForSubject };
    const { status, body } = await noclulabsGetReadable(SCORE_PATH, query, READABLE_STATUSES);

    if (status === 422) {
      const parsed = errorSchema.safeParse(body);
      if (!parsed.success) {
        throw new NoclulabsClientError("network", "noclulabs score returned an unexpected 422 body");
      }
      // Key the stale path off unknown_subject specifically; any other 422 string is
      // treated as a (non-stale) invalid request, the safe direction.
      return parsed.data.error === "unknown_subject"
        ? { kind: "unknown_subject" }
        : { kind: "invalid_request" };
    }

    // The only readable non-2xx is 422, so any status reaching here is a 2xx success.
    const parsed = successSchema.safeParse(body);
    if (!parsed.success) {
      throw new NoclulabsClientError("network", "noclulabs score returned an unexpected success body");
    }
    return {
      kind: "ok",
      subject: parsed.data.subject,
      publicScore: parsed.data.publicScore,
      trueScore: parsed.data.trueScore,
    };
  },
};
