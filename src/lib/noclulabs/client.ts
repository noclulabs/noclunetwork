import { getConfig } from "@/config.js";

// The noclulabs.com integration boundary. noCluNetwork is a relying party of
// noclulabs.com: it calls the locked v3 bridge contract over HTTP with a bearer
// service token. This base module is the shared transport; the emit client and
// the summon client will join verified-connections.ts here in later sessions.
//
// The token is attached to the Authorization header and is never logged. Errors
// carry no token and the URL never carries it (it lives only in the header).

// The kinds of failure a noclulabs.com call can produce, each a distinct, typed,
// switchable condition. The caller (the poller) decides which are transient
// (retry on the next tick) and which are anomalies.
export type NoclulabsErrorKind =
  // 401: the service token is missing or rejected.
  | "unauthorized"
  // 500: the remote reported server_misconfigured (its own env is unset), or our
  // own base URL or token is unset (a local misconfiguration that should not occur
  // when the poller is enabled, since the config refine guarantees both).
  | "server_misconfigured"
  // Any other non-2xx response.
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

function buildUrl(baseUrl: string, path: string, query: QueryParams): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// Authed GET against noclulabs.com. Resolves the base URL and service token from
// config, attaches the bearer, enforces the configured timeout via an
// AbortController, and maps the response into the parsed JSON body or a typed
// NoclulabsClientError. The body is returned as unknown; the caller validates its
// shape (do not trust the wire shape).
export async function noclulabsGet(path: string, query: QueryParams = {}): Promise<unknown> {
  const { NOCLULABS_BASE_URL, NOCLULABS_SERVICE_TOKEN, NOCLULABS_HTTP_TIMEOUT_MS } = getConfig();

  if (!NOCLULABS_BASE_URL || !NOCLULABS_SERVICE_TOKEN) {
    // Defensive: the config refine guarantees both are set whenever the poller is
    // enabled, so reaching here means a caller ran the client while disabled.
    throw new NoclulabsClientError(
      "server_misconfigured",
      "noclulabs base url or service token is not configured",
    );
  }

  const url = buildUrl(NOCLULABS_BASE_URL, path, query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOCLULABS_HTTP_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          // The token lives only here, never in the URL or a log line.
          authorization: `Bearer ${NOCLULABS_SERVICE_TOKEN}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
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
    if (!response.ok) {
      throw new NoclulabsClientError(
        "unexpected_status",
        `noclulabs returned an unexpected status ${response.status}`,
        { status: response.status },
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new NoclulabsClientError("network", "noclulabs returned a body that was not valid JSON", {
        cause: error,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}
