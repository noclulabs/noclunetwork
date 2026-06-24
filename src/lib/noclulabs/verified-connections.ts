import { z } from "zod";
import { noclulabsGet, type QueryParams } from "./client.js";

// Surface B of the locked v3 bridge contract, as built and live on noclulabs.com:
//
//   GET /api/identity/connections/verified?provider=&since=&limit=
//
// Returns every verified connection for a provider, paginated by a uuidv7 cursor.
// The tuple (provider, providerAccountId, noclulabsIdentityId) maps with no
// transformation onto our claim tuple (platform, platformUserId,
// noclulabsIdentityId). The endpoint returns connections at every visibility level
// and does not filter soft-deleted owners; both are intentional and handled
// downstream (the claim is idempotent and a claim against a soon-deleted identity
// is benign), not here.

const VERIFIED_CONNECTIONS_PATH = "/api/identity/connections/verified";

// Validate the wire shape before returning it; the network boundary is not
// trusted. Unknown keys are stripped (forward-compatible with additive contract
// changes). The identity id is validated as a uuid because the poller drives the
// claim service directly, bypassing the route's own body validation.
const connectionSchema = z.object({
  provider: z.string().min(1),
  providerAccountId: z.string().min(1),
  noclulabsIdentityId: z.uuid(),
  cursor: z.string().min(1),
});

const pageSchema = z.object({
  connections: z.array(connectionSchema),
  // The id of the last row, or null when the page is empty.
  nextCursor: z.string().nullable(),
});

export type VerifiedConnection = z.infer<typeof connectionSchema>;
export type VerifiedConnectionsPage = z.infer<typeof pageSchema>;

export interface FetchVerifiedConnectionsParams {
  provider: string;
  // The uuidv7 cursor to read after; omit (null or undefined) to start from the
  // beginning.
  since?: string | null;
  // The page size to request; the server clamps to its own maximum.
  limit: number;
}

// The port the poller depends on. The poller takes this interface, not the
// concrete module below, so the test path injects a fake and touches no network.
export interface VerifiedConnectionsClient {
  fetch(params: FetchVerifiedConnectionsParams): Promise<VerifiedConnectionsPage>;
}

// The real client: build the query, call surface B through the base helper, and
// validate the response before returning it.
export const verifiedConnectionsClient: VerifiedConnectionsClient = {
  async fetch({ provider, since, limit }: FetchVerifiedConnectionsParams): Promise<VerifiedConnectionsPage> {
    const query: QueryParams = { provider, limit };
    if (since !== undefined && since !== null) {
      query.since = since;
    }
    const body = await noclulabsGet(VERIFIED_CONNECTIONS_PATH, query);
    return pageSchema.parse(body);
  },
};
