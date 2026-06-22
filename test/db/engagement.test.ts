import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "@/server.js";
import { closeDb, getDb } from "@/lib/db/index.js";
import { closeRedis } from "@/lib/redis/index.js";
import { participants } from "@/lib/db/schema/index.js";
import { xpForLevel } from "@/lib/leveling/index.js";
import { XP_PER_GRANT } from "@/services/engagement/grant.js";
import { resetDb } from "../helpers/db.js";
import { TEST_SERVICE_TOKEN } from "../constants.js";

let app: FastifyInstance;

function post(url: string, body: unknown, options: { token?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== false) {
    headers["x-service-token"] = TEST_SERVICE_TOKEN;
    headers["x-service-name"] = "test-bot";
  }
  return app.inject({ method: "POST", url, headers, payload: JSON.stringify(body) });
}

const engage = (body: unknown, options?: { token?: boolean }) =>
  post("/api/v1/engagement", body, options);
const resolveParticipant = (body: unknown) => post("/api/v1/participants/resolve", body);

async function networkXpOf(participantId: string): Promise<number> {
  const rows = await getDb()
    .select({ networkXp: participants.networkXp })
    .from(participants)
    .where(eq(participants.id, participantId));
  return rows[0]!.networkXp;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeRedis();
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

describe("POST /api/v1/engagement", () => {
  it("grants the configured XP on a first call, returns the new level, and reports granted", async () => {
    const response = await engage({
      platform: "discord",
      platformUserId: "u-first",
      platformGroupId: "g-first",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.granted).toBe(true);
    // The membership was ensured as part of the engagement.
    expect(body.data.membership.active).toBe(true);
    expect(body.data.membership.permissionLevel).toBe(0);
    // network_xp went from 0 to the flat grant; the derived level follows the
    // curve (20 XP is exactly the level 2 threshold).
    expect(body.data.participant.networkXp).toBe(XP_PER_GRANT);
    expect(body.data.participant.networkLevel).toBe(2);
    // A first grant crosses out of level 0, so it is a level-up from 0.
    expect(body.data.leveledUp).toBe(true);
    expect(body.data.previousLevel).toBe(0);

    const participantId = body.data.participant.id as string;
    expect(await networkXpOf(participantId)).toBe(XP_PER_GRANT);
  });

  it("reports a level-up across a threshold with the previous level", async () => {
    // Stand the participant just below the level 5 threshold, then a single grant
    // crosses it. The participant is resolved without engaging, so no cooldown is
    // set and the engagement call below is the first to grant.
    const created = await resolveParticipant({ platform: "discord", platformUserId: "u-levelup" });
    const participantId = created.json().data.participant.id as string;
    const justBelowLevel5 = xpForLevel(5) - 5;
    await getDb()
      .update(participants)
      .set({ networkXp: justBelowLevel5 })
      .where(eq(participants.id, participantId));

    const response = await engage({
      platform: "discord",
      platformUserId: "u-levelup",
      platformGroupId: "g-levelup",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.granted).toBe(true);
    expect(body.data.participant.networkXp).toBe(justBelowLevel5 + XP_PER_GRANT);
    expect(body.data.leveledUp).toBe(true);
    expect(body.data.participant.networkLevel).toBe(5);
    expect(body.data.previousLevel).toBe(4);
  });

  it("grants nothing on a second call inside the cooldown window", async () => {
    const first = await engage({
      platform: "discord",
      platformUserId: "u-cd",
      platformGroupId: "g-cd",
    });
    expect(first.json().data.granted).toBe(true);
    const participantId = first.json().data.participant.id as string;
    expect(first.json().data.participant.networkXp).toBe(XP_PER_GRANT);

    const second = await engage({
      platform: "discord",
      platformUserId: "u-cd",
      platformGroupId: "g-cd",
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    // Inside the cooldown: a no-op success, no grant, no level-up.
    expect(body.data.granted).toBe(false);
    expect(body.data.leveledUp).toBe(false);
    expect(body.data.previousLevel).toBeUndefined();
    // The no-op still reports the current standing.
    expect(body.data.participant.networkXp).toBe(XP_PER_GRANT);
    expect(body.data.participant.networkLevel).toBe(2);
    // network_xp did not move.
    expect(await networkXpOf(participantId)).toBe(XP_PER_GRANT);
  });

  it("accrues independently per community under separate cooldowns", async () => {
    // The same participant engages in two different communities. Each community
    // has its own cooldown key, so both grant.
    const inA = await engage({
      platform: "discord",
      platformUserId: "u-multi",
      platformGroupId: "g-multi-a",
    });
    const inB = await engage({
      platform: "discord",
      platformUserId: "u-multi",
      platformGroupId: "g-multi-b",
    });
    expect(inA.json().data.granted).toBe(true);
    expect(inB.json().data.granted).toBe(true);
    // Same participant across both communities (resolved on platformUserId).
    const participantId = inA.json().data.participant.id as string;
    expect(inB.json().data.participant.id).toBe(participantId);
    // The lifetime total is network-wide: it summed both communities' grants.
    expect(inA.json().data.participant.networkXp).toBe(XP_PER_GRANT);
    expect(inB.json().data.participant.networkXp).toBe(XP_PER_GRANT * 2);
    expect(await networkXpOf(participantId)).toBe(XP_PER_GRANT * 2);
  });

  it("grants exactly once for two simultaneous engagements (the SET NX gate)", async () => {
    const payload = { platform: "discord", platformUserId: "u-race", platformGroupId: "g-race" };
    const [a, b] = await Promise.all([engage(payload), engage(payload)]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const bodyA = a.json();
    const bodyB = b.json();
    // Same participant; exactly one of the two calls won the grant.
    expect(bodyA.data.participant.id).toBe(bodyB.data.participant.id);
    expect([bodyA.data.granted, bodyB.data.granted].filter(Boolean)).toHaveLength(1);
    // The SET NX gate granted XP exactly once: no double increment.
    const participantId = bodyA.data.participant.id as string;
    expect(await networkXpOf(participantId)).toBe(XP_PER_GRANT);
  });

  it("returns 400 for a platform absent from the registry", async () => {
    const response = await engage({
      platform: "telegram",
      platformUserId: "u-x",
      platformGroupId: "g-x",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);
  });

  it("returns 401 when the service token is missing", async () => {
    const response = await engage(
      { platform: "discord", platformUserId: "u-x", platformGroupId: "g-x" },
      { token: false },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});
