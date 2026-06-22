import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "@/server.js";
import { closeDb, getDb, getPool } from "@/lib/db/index.js";
import {
  communities,
  communityPlatforms,
  participants,
  platformAccounts,
} from "@/lib/db/schema/index.js";
import { resetDb } from "../helpers/db.js";
import { TEST_SERVICE_TOKEN } from "../constants.js";

// Narrow the first row of a returning() result without a non-null assertion;
// noUncheckedIndexedAccess types rows[0] as possibly undefined.
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected at least one row");
  }
  return row;
}

let app: FastifyInstance;

function post(url: string, body: unknown, options: { token?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== false) {
    headers["x-service-token"] = TEST_SERVICE_TOKEN;
    headers["x-service-name"] = "test-bot";
  }
  return app.inject({ method: "POST", url, headers, payload: JSON.stringify(body) });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

describe("migration", () => {
  it("created the citext and pgcrypto extensions", async () => {
    const result = await getPool().query(
      "select extname from pg_extension where extname = any($1::text[])",
      [["citext", "pgcrypto"]],
    );
    const names = result.rows.map((row) => row.extname as string);
    expect(names).toContain("citext");
    expect(names).toContain("pgcrypto");
  });

  it("created all five data-model tables", async () => {
    const result = await getPool().query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])",
      [
        [
          "participants",
          "platform_accounts",
          "communities",
          "community_platforms",
          "community_members",
        ],
      ],
    );
    const tables = result.rows.map((row) => row.table_name as string).sort();
    expect(tables).toEqual([
      "communities",
      "community_members",
      "community_platforms",
      "participants",
      "platform_accounts",
    ]);
  });

  it("advances updated_at on update via the set_updated_at trigger", async () => {
    const past = new Date("2000-01-01T00:00:00.000Z");
    const inserted = first(
      await getDb()
        .insert(communities)
        .values({ name: "trigger-before", createdAt: past, updatedAt: past })
        .returning(),
    );
    expect(inserted.updatedAt.getTime()).toBe(past.getTime());

    const updated = first(
      await getDb()
        .update(communities)
        .set({ name: "trigger-after" })
        .where(eq(communities.id, inserted.id))
        .returning(),
    );

    // The trigger moved updated_at to now() and left created_at untouched.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(past.getTime());
    expect(Math.abs(updated.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(updated.createdAt.getTime()).toBe(past.getTime());
  });
});

describe("POST /api/v1/participants/resolve", () => {
  it("creates a ghost participant and a primary unverified account on first resolve", async () => {
    const response = await post("/api/v1/participants/resolve", {
      platform: "discord",
      platformUserId: "100",
      platformUsername: "alice",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.created).toBe(true);
    expect(body.data.participant.noclulabsIdentityId).toBeNull();
    expect(body.data.platformAccount.platform).toBe("discord");
    expect(body.data.platformAccount.platformUserId).toBe("100");
    expect(body.data.platformAccount.verified).toBe(false);
    expect(body.data.platformAccount.isPrimary).toBe(true);

    expect(await getDb().select().from(participants)).toHaveLength(1);
    expect(await getDb().select().from(platformAccounts)).toHaveLength(1);
  });

  it("is idempotent on (platform, platformUserId) and creates no duplicate", async () => {
    const created = await post("/api/v1/participants/resolve", {
      platform: "discord",
      platformUserId: "200",
    });
    const participantId = created.json().data.participant.id;

    const again = await post("/api/v1/participants/resolve", {
      platform: "discord",
      platformUserId: "200",
    });
    const body = again.json();

    expect(body.data.created).toBe(false);
    expect(body.data.participant.id).toBe(participantId);
    expect(await getDb().select().from(participants)).toHaveLength(1);
    expect(await getDb().select().from(platformAccounts)).toHaveLength(1);
  });

  it("updates the stored username when a new one is provided", async () => {
    await post("/api/v1/participants/resolve", {
      platform: "discord",
      platformUserId: "300",
      platformUsername: "old-handle",
    });
    const response = await post("/api/v1/participants/resolve", {
      platform: "discord",
      platformUserId: "300",
      platformUsername: "new-handle",
    });

    expect(response.json().data.created).toBe(false);
    const accounts = await getDb()
      .select()
      .from(platformAccounts)
      .where(eq(platformAccounts.platformUserId, "300"));
    expect(first(accounts).platformUsername).toBe("new-handle");
  });

  it("rejects a direct duplicate (platform, platformUserId) at the database", async () => {
    const created = await post("/api/v1/participants/resolve", {
      platform: "discord",
      platformUserId: "400",
    });
    const participantId = created.json().data.participant.id as string;

    await expect(
      getDb()
        .insert(platformAccounts)
        .values({ participantId, platform: "discord", platformUserId: "400" }),
    ).rejects.toThrow();
  });

  it("is race-safe under concurrent resolves of the same (platform, platformUserId)", async () => {
    const [a, b] = await Promise.all([
      post("/api/v1/participants/resolve", { platform: "discord", platformUserId: "race-1" }),
      post("/api/v1/participants/resolve", { platform: "discord", platformUserId: "race-1" }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const bodyA = a.json();
    const bodyB = b.json();
    expect(bodyA.data.participant.id).toBe(bodyB.data.participant.id);
    // Exactly one of the two concurrent calls created the participant.
    expect([bodyA.data.created, bodyB.data.created].filter(Boolean)).toHaveLength(1);
    expect(await getDb().select().from(participants)).toHaveLength(1);
    expect(await getDb().select().from(platformAccounts)).toHaveLength(1);
  });

  it("returns 400 for a platform absent from the registry", async () => {
    const response = await post("/api/v1/participants/resolve", {
      platform: "telegram",
      platformUserId: "999",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);
  });

  it("returns 401 when the service token is missing", async () => {
    const response = await post(
      "/api/v1/participants/resolve",
      { platform: "discord", platformUserId: "1" },
      { token: false },
    );

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/v1/communities/resolve", () => {
  it("creates a community and platform mapping on first resolve", async () => {
    const response = await post("/api/v1/communities/resolve", {
      platform: "discord",
      platformGroupId: "guild-1",
      name: "Test Guild",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.created).toBe(true);
    expect(body.data.community.name).toBe("Test Guild");
    expect(body.data.communityPlatform.platform).toBe("discord");
    expect(body.data.communityPlatform.platformGroupId).toBe("guild-1");

    expect(await getDb().select().from(communities)).toHaveLength(1);
    expect(await getDb().select().from(communityPlatforms)).toHaveLength(1);
  });

  it("derives a placeholder name from the platform group id when none is given", async () => {
    const response = await post("/api/v1/communities/resolve", {
      platform: "discord",
      platformGroupId: "guild-2",
    });

    const body = response.json();
    expect(body.data.created).toBe(true);
    expect(body.data.community.name).toContain("guild-2");
  });

  it("is idempotent on (platform, platformGroupId) and does not rename the existing community", async () => {
    const created = await post("/api/v1/communities/resolve", {
      platform: "discord",
      platformGroupId: "guild-3",
      name: "First name",
    });
    const communityId = created.json().data.community.id;

    const again = await post("/api/v1/communities/resolve", {
      platform: "discord",
      platformGroupId: "guild-3",
      name: "Ignored name",
    });
    const body = again.json();

    expect(body.data.created).toBe(false);
    expect(body.data.community.id).toBe(communityId);
    expect(body.data.community.name).toBe("First name");
    expect(await getDb().select().from(communities)).toHaveLength(1);
  });

  it("rejects a direct duplicate (platform, platformGroupId) at the database", async () => {
    const created = await post("/api/v1/communities/resolve", {
      platform: "discord",
      platformGroupId: "guild-4",
      name: "Dup",
    });
    const communityId = created.json().data.community.id as string;

    await expect(
      getDb()
        .insert(communityPlatforms)
        .values({ communityId, platform: "discord", platformGroupId: "guild-4" }),
    ).rejects.toThrow();
  });

  it("is race-safe under concurrent resolves of the same (platform, platformGroupId)", async () => {
    const [a, b] = await Promise.all([
      post("/api/v1/communities/resolve", { platform: "discord", platformGroupId: "race-guild" }),
      post("/api/v1/communities/resolve", { platform: "discord", platformGroupId: "race-guild" }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const bodyA = a.json();
    const bodyB = b.json();
    expect(bodyA.data.community.id).toBe(bodyB.data.community.id);
    // Exactly one of the two concurrent calls created the community.
    expect([bodyA.data.created, bodyB.data.created].filter(Boolean)).toHaveLength(1);
    expect(await getDb().select().from(communities)).toHaveLength(1);
    expect(await getDb().select().from(communityPlatforms)).toHaveLength(1);
  });
});
