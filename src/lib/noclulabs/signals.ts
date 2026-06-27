import { z } from "zod";
import { NoclulabsClientError, noclulabsPost } from "./client.js";

// Surface A of the locked v3 bridge contract, as built and live on noclulabs.com:
//
//   POST /api/identity/signals   (bearer-gated)
//
// Body: { subjectIdentityId, signalType, value, observedAt }. The server sets
// source itself (noclu-network); we never send it. noclulabs.com is idempotent by
// conditional append: an unchanged value writes nothing (written false), so
// re-emits are safe no-ops and the orchestration does not pre-check the value.
//
// Responses we model:
//   200 { ok, written }                  the signal was accepted (a success)
//   422 { error: "unknown_subject" }     the subject is missing or soft-deleted
//   422 { error: "invalid_request" }     the request body was malformed
//   401                                  a bad token (thrown by the base client)
//   500 server_misconfigured             remote env unset (thrown by the base)
//
// The two 422s mean different things. unknown_subject is a stale link (the
// noclulabs.com user was deleted, made permanent by the FK cascade on their side):
// stop emitting for that subject. invalid_request is a bug in our request to fix,
// never a stale link, so stale-link handling is keyed off unknown_subject only.

const SIGNALS_PATH = "/api/identity/signals";

// The 422 status carries a meaningful application body we must inspect, so the
// POST returns it rather than mapping it to a thrown transport error. Every other
// non-2xx (401, 500, anything else) stays a thrown NoclulabsClientError.
const READABLE_STATUSES: ReadonlySet<number> = new Set([422]);

// 200 body. written is false when the value was unchanged and nothing was inserted.
const successSchema = z.object({ ok: z.boolean(), written: z.boolean() });
// 422 body. The error discriminant (unknown_subject or invalid_request).
const errorSchema = z.object({ error: z.string() });

export interface EmitSignalParams {
  // The participant's noclulabs_identity_id (a uuid).
  subjectIdentityId: string;
  // The signal type string (for the leveling contribution, "network.level").
  signalType: string;
  // The signal value in the range [0, 1].
  value: number;
  // An ISO 8601 timestamp for when the signal was observed.
  observedAt: string;
}

// The typed outcome of an emit. Transport, auth, and server errors (401, 500, any
// other non-2xx, a network error or timeout) are thrown as NoclulabsClientError by
// the base client and are NOT part of this union; the orchestration's best-effort
// wrapper swallows them. The two 422 outcomes are returned, not thrown, because the
// caller acts on each differently.
export type EmitResult =
  // 200: the signal was accepted. written is false when the value was unchanged and
  // nothing was inserted (a safe no-op the conditional append guarantees).
  | { kind: "written"; written: boolean }
  // 422 unknown_subject: the noclulabs.com subject is missing or soft-deleted. A
  // confirmed stale link; the caller marks the subject and stops emitting for it.
  | { kind: "unknown_subject" }
  // 422 invalid_request: our request body was malformed. A bug to fix, NOT a stale
  // link; the caller must never key stale-link handling off this.
  | { kind: "invalid_request" };

// The port the orchestration depends on, so the test path injects a fake and
// touches no network. emit POSTs one signal to surface A and returns the typed
// outcome.
export interface SignalsClient {
  emit(params: EmitSignalParams): Promise<EmitResult>;
}

// The real client: POST the signal to surface A and validate the response before
// returning a typed outcome. The wire shape is not trusted; a body that fails
// validation is a malformed response (a network-kind error).
export const signalsClient: SignalsClient = {
  async emit(params: EmitSignalParams): Promise<EmitResult> {
    const { status, body } = await noclulabsPost(SIGNALS_PATH, params, READABLE_STATUSES);

    if (status === 422) {
      const parsed = errorSchema.safeParse(body);
      if (!parsed.success) {
        throw new NoclulabsClientError("network", "noclulabs signals returned an unexpected 422 body");
      }
      // Key the stale-link path off unknown_subject specifically. Any other 422
      // error string is treated as a (non-stale) invalid request, the safe
      // direction: we never falsely mark a subject stale.
      return parsed.data.error === "unknown_subject"
        ? { kind: "unknown_subject" }
        : { kind: "invalid_request" };
    }

    // The only readable non-2xx is 422, so any status reaching here is a 2xx success.
    const parsed = successSchema.safeParse(body);
    if (!parsed.success) {
      throw new NoclulabsClientError("network", "noclulabs signals returned an unexpected success body");
    }
    return { kind: "written", written: parsed.data.written };
  },
};
