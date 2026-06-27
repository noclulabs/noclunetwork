import { getConfig } from "@/config.js";

// The noclulabs.com integration boundary. noCluNetwork is a relying party of
// noclulabs.com: it calls the locked v3 bridge contract over HTTP with a bearer
// service token. This base module is the shared transport; the verify-sync poller
// (surface B, via verified-connections.ts) and the emit client (surface A, via
// signals.ts) both build on it.
//
// The token is attached to the Authorization header and is never logged. Errors
// carry no token and the URL never carries it (it lives only in the header).

// The kinds of failure a noclulabs.com call can produce, each a distinct, typed,
// switchable condition. The caller (the poller, the emit client) decides which are
// transient (retry on the next tick) and which are anomalies.
export type NoclulabsErrorKind =
  // 401: the service token is missing or rejected.
  | "unauthorized"
  // 500: the remote reported server_misconfigured (its own env is unset), or our
  // own base URL or token is unset (a local misconfiguration that should not occur
  // when a consumer is enabled, since the config refines guarantee both).
  | "server_misconfigured"
  // Any other non-2xx response that the caller did not list as readable.
  | "unexpected_status"
  // The request failed to complete: a network error, or the timeout aborted it,
  // or the body was not valid JSON.
  | "network";

export class NoclulabsClientError extends Error {
  readonly kind: NoclulabsErrorKind;
  readonly status?: number;

  constructor(kind: NoclulabsErrorKind, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NoclulabsClientError";
    this.kind = kind;
    this.status = options?.status;
  }
}

// A query value map. undefined values are dropped, so an optional parameter
// (for example since on the first poll) is simply omitted.
export type QueryParams = Record<string, string | number | undefined>;

// The result of a request whose status the caller wants to inspect: the HTTP
// status and the parsed JSON body. Returned for a 2xx and for any non-2xx status
// the caller listed as readable (surface A returns a meaningful 422 body); every
// other non-2xx is mapped to a thrown NoclulabsClientError instead.
export interface NoclulabsResponse {
  status: number;
  body: unknown;
}

function buildUrl(baseUrl: string, path: string, query: QueryParams): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  query?: QueryParams;
  // The JSON request body for a POST. Serialized and sent with a JSON content-type.
  body?: unknown;
  // Non-2xx statuses whose JSON body the caller will inspect rather than have
  // mapped to a thrown error. 401, 500, and any other non-2xx not listed here are
  // always thrown as typed errors regardless.
  readableStatuses?: ReadonlySet<number>;
}

// The shared authed request against noclulabs.com. Resolves the base URL and
// service token from config, attaches the bearer, enforces the configured timeout
// via an AbortController, and maps the response into a NoclulabsResponse (the
// status plus the parsed JSON body) or a typed NoclulabsClientError. The body is
// returned as unknown; the caller validates its shape (do not trust the wire
// shape). GET and POST below are thin wrappers over this one core.
async function noclulabsRequest(options: RequestOptions): Promise<NoclulabsResponse> {
  const { NOCLULABS_BASE_URL, NOCLULABS_SERVICE_TOKEN, NOCLULABS_HTTP_TIMEOUT_MS } = getConfig();

  if (!NOCLULABS_BASE_URL || !NOCLULABS_SERVICE_TOKEN) {
    // Defensive: the config refines guarantee both are set whenever a consumer is
    // enabled, so reaching here means a caller ran the client while disabled.
    throw new NoclulabsClientError(
      "server_misconfigured",
      "noclulabs base url or service token is not configured",
    );
  }

  const url = buildUrl(NOCLULABS_BASE_URL, options.path, options.query ?? {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOCLULABS_HTTP_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      // The token lives only here, never in the URL or a log line.
      authorization: `Bearer ${NOCLULABS_SERVICE_TOKEN}`,
      accept: "application/json",
    };
    const init: RequestInit = { method: options.method, headers, signal: controller.signal };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      // A transport failure or the timeout aborting the request. The error carries
      // no token (it is only ever a header), so it is safe to keep as the cause.
      throw new NoclulabsClientError("network", "noclulabs request did not complete", {
        cause: error,
      });
    }

    if (response.status === 401) {
      throw new NoclulabsClientError("unauthorized", "noclulabs rejected the service token", {
        status: 401,
      });
    }
    if (response.status === 500) {
      throw new NoclulabsClientError("server_misconfigured", "noclulabs reported server_misconfigured", {
        status: 500,
      });
    }
    const readable = options.readableStatuses?.has(response.status) ?? false;
    if (!response.ok && !readable) {
      throw new NoclulabsClientError(
        "unexpected_status",
        `noclulabs returned an unexpected status ${response.status}`,
        { status: response.status },
      );
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch (error) {
      throw new NoclulabsClientError("network", "noclulabs returned a body that was not valid JSON", {
        cause: error,
      });
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

// Authed GET against noclulabs.com. Returns the parsed JSON body (a 2xx) or throws
// a typed NoclulabsClientError. Used by the verify-sync poller (surface B).
export async function noclulabsGet(path: string, query: QueryParams = {}): Promise<unknown> {
  const { body } = await noclulabsRequest({ method: "GET", path, query });
  return body;
}

// Authed POST against noclulabs.com. Returns the status and parsed body for a 2xx
// or for any readableStatuses the caller passed (so it can inspect a meaningful
// non-2xx body, like surface A's 422), and throws a typed NoclulabsClientError for
// 401, 500, any other non-2xx, or a transport, timeout, or non-JSON failure. Used
// by the emit client (surface A).
export async function noclulabsPost(
  path: string,
  body: unknown,
  readableStatuses?: ReadonlySet<number>,
): Promise<NoclulabsResponse> {
  return noclulabsRequest({ method: "POST", path, body, readableStatuses });
}
