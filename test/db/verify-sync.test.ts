import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/lib/db/index.js";
import { participants, platformAccounts, syncWatermarks } from "@/lib/db/schema/index.js";
import { ApiError } from "@/plugins/error-handler.js";
import { claimParticipant } from "@/services/participants/claim.js";
import {
  createVerifySyncPoller,
  type ClaimFn,
  type VerifySyncLogger,
  type VerifySyncPoller,
} from "@/services/verify-sync/poller.js";
import { dbWatermarkStore, type WatermarkStore } from "@/services/verify-sync/watermark.js";
import { DISCORD_PROVIDER, DISCORD_VERIFIED_STREAM } from "@/services/verify-sync/streams.js";
import type {
  VerifiedConnection,
  VerifiedConnectionsClient,
  VerifiedConnectionsPage,
} from "@/lib/noclulabs/verified-connections.js";
import { resetDb } from "../helpers/db.js";

const STREAM = DISCORD_VERIFIED_STREAM;

const silentLogger: VerifySyncLogger = {
  info() {},
  warn() {},
  error() {},
};

// A fake surface-B client over an in-memory dataset. It reproduces the contract's
// cursor semantics: connections are sorted by cursor and a fetch returns those
// with cursor > since (all of them when since is null), up to limit, with
// nextCursor as the last returned cursor (null on an empty page). The same fake
// serves the fast path and the re-scan; only the since differs, exactly as the
// real endpoint behaves. It records the since values it was queried with so a test
// can assert the watermark was read and passed back.
function makeFakeClient(connections: VerifiedConnection[]) {
  const sorted = [...connections].sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
  const sinceCalls: (string | null | undefined)[] = [];
  const client: VerifiedConnectionsClient = {
    async fetch({ since, limit }): Promise<VerifiedConnectionsPage> {
      sinceCalls.push(since);
      const after = since ?? "";
      const matching = sorted.filter((connection) => connection.cursor > after).slice(0, limit);
      const last = matching[matching.length - 1];
      return {
        connections: matching.map((connection) => ({ ...connection })),
        nextCursor: last === undefined ? null : last.cursor,
      };
    },
  };
  return { client, sinceCalls, callCount: () => sinceCalls.length };
}

// A watermark store that delegates to the Postgres-backed store but records every
// cursor write, so a test can assert the fast path advances once per page.
function makeSpyStore(): { store: WatermarkStore; cursorWrites: (string | null)[] } {
  const cursorWrites: (string | null)[] = [];
  const store: WatermarkStore = {
    read: (stream) => dbWatermarkStore.read(stream),
    async setCursor(stream, cursor) {
      cursorWrites.push(cursor);
      await dbWatermarkStore.setCursor(stream, cursor);
    },
    setFullRescanAt: (stream, at) => dbWatermarkStore.setFullRescanAt(stream, at),
  };
  return { store, cursorWrites };
}

function buildPoller(opts: {
  client: VerifiedConnectionsClient;
  claim?: ClaimFn;
  store?: WatermarkStore;
  logger?: VerifySyncLogger;
  pageSize?: number;
}): VerifySyncPoller {
  return createVerifySyncPoller({
    client: opts.client,
    claim: opts.claim ?? claimParticipant,
    watermarks: opts.store ?? dbWatermarkStore,
    logger: opts.logger ?? silentLogger,
    provider: DISCORD_PROVIDER,
    stream: STREAM,
    pageSize: opts.pageSize ?? 200,
    now: () => new Date(),
  });
}

// Build a synthetic connection with an ordered, zero-padded cursor so lexical
// comparison matches numeric order (as it does for the real uuidv7 cursors).
function conn(n: number): VerifiedConnection {
  const idx = String(n).padStart(3, "0");
  return {
    provider: "discord",
    providerAccountId: `discord-user-${idx}`,
    noclulabsIdentityId: randomUUID(),
    cursor: `c${idx}`,
  };
}

async function participantByIdentity(identityId: string) {
  const rows = await getDb()
    .select()
    .from(participants)
    .where(eq(participants.noclulabsIdentityId, identityId));
  return rows[0];
}

async function accountByUserId(userId: string) {
  const rows = await getDb()
    .select()
    .from(platformAccounts)
    .where(eq(platformAccounts.platformUserId, userId));
  return rows[0];
}

async function countParticipants(): Promise<number> {
  return (await getDb().select().from(participants)).length;
}

async function watermarkRow() {
  const rows = await getDb().select().from(syncWatermarks).where(eq(syncWatermarks.stream, STREAM));
  return rows[0];
}

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  // resetDb creates the lazy db pool on first use and truncates every table
  // (sync_watermarks included) between cases.
  await resetDb();
});

describe("verify-sync poller", () => {
  it("claims every connection in a single page and advances the watermark to its nextCursor", async () => {
    const data = [conn(1), conn(2), conn(3)];
    const { client } = makeFakeClient(data);
    const poller = buildPoller({ client });

    const result = await poller.runIncrementalCycle();

    expect(result.claimed).toBe(3);
    expect(result.connectionsProcessed).toBe(3);
    expect(await countParticipants()).toBe(3);
    for (const connection of data) {
      const participant = await participantByIdentity(connection.noclulabsIdentityId);
      expect(participant, `connection ${connection.cursor} should be linked`).toBeDefined();
      const account = await accountByUserId(connection.providerAccountId);
      expect(account?.participantId).toBe(participant?.id);
      expect(account?.verified).toBe(true);
    }
    expect((await watermarkRow())?.cursor).toBe("c003");
  });

  it("drains across pages, advancing the fast-path cursor once per page", async () => {
    const data = [conn(1), conn(2), conn(3), conn(4), conn(5)];
    const { client, callCount } = makeFakeClient(data);
    const { store, cursorWrites } = makeSpyStore();
    const poller = buildPoller({ client, store, pageSize: 2 });

    const result = await poller.runIncrementalCycle();

    expect(result.claimed).toBe(5);
    expect(result.pagesProcessed).toBe(3);
    expect(await countParticipants()).toBe(5);
    // Three fetches: a full page (c001, c002), a full page (c003, c004), then a
    // short page (c005) that ends the drain.
    expect(callCount()).toBe(3);
    // The cursor advanced per page, ending at the last connection's cursor.
    expect(cursorWrites).toEqual(["c002", "c004", "c005"]);
    expect((await watermarkRow())?.cursor).toBe("c005");
  });

  it("is idempotent: re-running the cycle over the same data creates no duplicates and yields already-linked", async () => {
    const data = [conn(1), conn(2), conn(3)];
    const { client } = makeFakeClient(data);
    const poller = buildPoller({ client });

    const first = await poller.runFullRescan();
    expect(first.claimed).toBe(3);
    expect(await countParticipants()).toBe(3);

    const second = await poller.runFullRescan();
    expect(second.claimed).toBe(0);
    expect(second.alreadyLinked).toBe(3);
    // No duplicate participants on the second pass.
    expect(await countParticipants()).toBe(3);
  });

  it("closes the commit-order gap: the re-scan claims a connection the fast path skipped, without moving the fast-path cursor", async () => {
    // Five connections; c002 is the one that committed out of order and was missed.
    const data = [conn(1), conn(2), conn(3), conn(4), conn(5)];
    const skipped = data[1]!;
    const { client } = makeFakeClient(data);
    const poller = buildPoller({ client });

    // Simulate the skip: the fast path advanced its cursor past c002 (to c005)
    // while c002 was not yet visible, so id > since will never return it again.
    await dbWatermarkStore.setCursor(STREAM, "c005");

    // The fast path cannot recover it: a cycle from c005 returns an empty page and
    // c002 stays unclaimed.
    const incremental = await poller.runIncrementalCycle();
    expect(incremental.connectionsProcessed).toBe(0);
    expect(await participantByIdentity(skipped.noclulabsIdentityId)).toBeUndefined();

    // The re-scan sweeps from the beginning and claims the skipped connection.
    const rescan = await poller.runFullRescan();
    expect(rescan.connectionsProcessed).toBe(5);
    const recovered = await participantByIdentity(skipped.noclulabsIdentityId);
    expect(recovered).toBeDefined();
    expect((await accountByUserId(skipped.providerAccountId))?.verified).toBe(true);

    // The re-scan did not disturb the fast-path cursor and recorded its completion.
    const row = await watermarkRow();
    expect(row?.cursor).toBe("c005");
    expect(row?.fullRescanAt).not.toBeNull();
  });

  it("persists the watermark durably and reads it back on the next cycle", async () => {
    const data = [conn(1), conn(2), conn(3)];
    const { client, sinceCalls } = makeFakeClient(data);
    const poller = buildPoller({ client });

    await poller.runIncrementalCycle();
    // The row persists with the advanced cursor.
    expect((await watermarkRow())?.cursor).toBe("c003");

    // The next cycle reads the persisted cursor and queries surface B with it.
    sinceCalls.length = 0;
    const second = await poller.runIncrementalCycle();
    expect(sinceCalls[0]).toBe("c003");
    expect(second.connectionsProcessed).toBe(0);
  });

  it("does not advance the watermark when a claim throws mid-page, then advances on a clean retry", async () => {
    const data = [conn(1), conn(2), conn(3)];
    const failUserId = data[1]!.providerAccountId;
    let shouldThrow = true;
    const claim: ClaimFn = async (input) => {
      if (shouldThrow && input.platformUserId === failUserId) {
        throw new Error("simulated transient database error");
      }
      return claimParticipant(input);
    };
    const { client } = makeFakeClient(data);
    const poller = buildPoller({ client, claim });

    // The first cycle throws partway through the page; the cursor never advances.
    await expect(poller.runIncrementalCycle()).rejects.toThrow("simulated transient database error");
    expect((await watermarkRow())?.cursor ?? null).toBeNull();
    // The first row committed before the throw; the failing row did not.
    expect(await participantByIdentity(data[0]!.noclulabsIdentityId)).toBeDefined();
    expect(await participantByIdentity(data[1]!.noclulabsIdentityId)).toBeUndefined();

    // The transient error clears; the next cycle re-fetches the same page (the
    // already-done row is idempotent) and completes, advancing the watermark.
    shouldThrow = false;
    const retry = await poller.runIncrementalCycle();
    expect(retry.connectionsProcessed).toBe(3);
    expect(await countParticipants()).toBe(3);
    expect((await watermarkRow())?.cursor).toBe("c003");
  });

  it("maps the connection tuple onto the claim tuple and verifies the platform account", async () => {
    const identity = randomUUID();
    const connection: VerifiedConnection = {
      provider: "discord",
      providerAccountId: "discord-user-tuple",
      noclulabsIdentityId: identity,
      cursor: "c001",
    };
    const { client } = makeFakeClient([connection]);
    const poller = buildPoller({ client });

    await poller.runIncrementalCycle();

    // provider -> platform, providerAccountId -> platformUserId.
    const account = await accountByUserId("discord-user-tuple");
    expect(account).toBeDefined();
    expect(account?.platform).toBe("discord");
    expect(account?.verified).toBe(true);
    // noclulabsIdentityId -> the linked participant's identity.
    const participant = await participantByIdentity(identity);
    expect(participant?.id).toBe(account?.participantId);
  });

  it("treats the account-already-verified conflict as a counted anomaly and still advances the page", async () => {
    const data = [conn(1), conn(2), conn(3)];
    const conflictUserId = data[1]!.providerAccountId;
    const claim: ClaimFn = async (input) => {
      if (input.platformUserId === conflictUserId) {
        throw new ApiError("ACCOUNT_ALREADY_VERIFIED", "simulated conflict", 409);
      }
      return claimParticipant(input);
    };
    const logger: VerifySyncLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = makeFakeClient(data);
    const poller = buildPoller({ client, claim, logger });

    const result = await poller.runIncrementalCycle();

    expect(result.conflicts).toBe(1);
    expect(result.claimed).toBe(2);
    expect(result.connectionsProcessed).toBe(3);
    // The conflict was logged with detail, the stream did not stall, and the page
    // still advanced past the conflicting row.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((await watermarkRow())?.cursor).toBe("c003");
    expect(await participantByIdentity(data[0]!.noclulabsIdentityId)).toBeDefined();
    expect(await participantByIdentity(data[2]!.noclulabsIdentityId)).toBeDefined();
  });

  it("skips a connection on an unregistered platform as an anomaly without stalling the stream", async () => {
    const good = conn(1);
    const bad: VerifiedConnection = {
      provider: "telegram",
      providerAccountId: "telegram-user-001",
      noclulabsIdentityId: randomUUID(),
      cursor: "c002",
    };
    const tail = conn(3);
    const logger: VerifySyncLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = makeFakeClient([good, bad, tail]);
    const poller = buildPoller({ client, logger });

    const result = await poller.runIncrementalCycle();

    expect(result.anomalies).toBe(1);
    expect(result.claimed).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The two registered-platform rows claimed; the unknown-platform row created
    // nothing; the page still advanced.
    expect(await accountByUserId("telegram-user-001")).toBeUndefined();
    expect((await watermarkRow())?.cursor).toBe("c003");
  });
});
