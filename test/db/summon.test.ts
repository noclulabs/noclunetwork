import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "@/server.js";
import { closeDb, getDb } from "@/lib/db/index.js";
import { closeRedis } from "@/lib/redis/index.js";
import { participants } from "@/lib/db/schema/index.js";
import { NoclulabsClientError } from "@/lib/noclulabs/client.js";
import type { FetchScoreParams, ScoreClient, ScoreResult } from "@/lib/noclulabs/score.js";
import {
  resetSummonRuntimeForTest,
  setSummonRuntimeForTest,
  type SummonLogger,
} from "@/services/summon/summon.js";
import { resetDb } from "../helpers/db.js";
import { TEST_SERVICE_TOKEN } from "../constants.js";

let app: FastifyInstance;

const silentLogger: SummonLogger = { info() {}, warn() {}, error() {} };

// token defaults to the valid test token; pass null to omit the header entirely (the
// missing-token case), since an omitted argument would otherwise take the default.
function post(url: string, body: unknown, token: string | null = TEST_SERVICE_TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) {
    headers["x-service-token"] = token;
    headers["x-service-name"] = "test-bot";
  }
  return app.inject({ method: "POST", url, headers, payload: JSON.stringify(body) });
}

const summonRoute = (body: unknown, token?: string | null) => post("/api/v1/summon", body, token);
const resolveP = (body: unknown) => post("/api/v1/participants/resolve", body);

// A fake ScoreClient that records every call and returns (or throws) a controllable
// outcome, injected through the summon runtime seam so the real service and route run
// offline. The default outcome is an ok with distinct true and public scores.
function defaultBehavior(params: FetchScoreParams): ScoreResult {
  return {
    kind: "ok",
    subject: params.subject,
    publicScore: { total: 0.42, breakdown: { network: 0.42 } },
    trueScore: { total: 0.88, breakdown: { network: 0.88, verified: true } },
  };
}

function makeFakeScore(
  behavior: (params: FetchScoreParams) => ScoreResult | Promise<ScoreResult> = defaultBehavior,
): { client: ScoreClient; calls: FetchScoreParams[] } {
  const calls: FetchScoreParams[] = [];
  const client: ScoreClient = {
    async fetchScore(params: FetchScoreParams): Promise<ScoreResult> {
      calls.push(params);
      return behavior(params);
    },
  };
  return { client, calls };
}

function enableSummon(client: ScoreClient): void {
  setSummonRuntimeForTest({ client, enabled: true, logger: silentLogger });
}

async function linkParticipant(id: string, identityId: string): Promise<void> {
  await getDb()
    .update(participants)
    .set({ noclulabsIdentityId: identityId })
    .where(eq(participants.id, id));
}

async function participantById(id: string) {
  const rows = await getDb().select().from(participants).where(eq(participants.id, id));
  return rows[0];
}

async function participantCount(): Promise<number> {
  return (await getDb().select().from(participants)).length;
}

// Resolve-or-create a ghost, then (optionally) link it to a noclulabs identity to
// simulate a prior claim. Returns the participant id and the identity (when linked).
async function seedClaimed(
  platformUserId: string,
): Promise<{ participantId: string; identity: string }> {
  const created = await resolveP({ platform: "discord", platformUserId });
  const participantId = created.json().data.participant.id as string;
  const identity = randomUUID();
  await linkParticipant(participantId, identity);
  return { participantId, identity };
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

afterEach(() => {
  // Always clear the override so a later case is not silently enabled.
  resetSummonRuntimeForTest();
});

describe("summon: claimed participant", () => {
  it("returns ok with both scores from a single surface C call", async () => {
    const { participantId, identity } = await seedClaimed("u-claimed");
    const { client, calls } = makeFakeScore();
    enableSummon(client);

    const response = await summonRoute({ platform: "discord", platformUserId: "u-claimed" });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.outcome).toBe("ok");
    expect(data.subject).toBe(identity);
    expect(data.publicScore.total).toBe(0.42);
    expect(data.trueScore.total).toBe(0.88);
    // The breakdown passthrough is preserved through validation and serialization.
    expect(data.trueScore.breakdown).toEqual({ network: 0.88, verified: true });
    expect(data.publicScore.breakdown).toEqual({ network: 0.42 });

    // Exactly one call, carrying the participant's identity as the subject.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe(identity);
    // The participant was not mutated by the read.
    expect((await participantById(participantId))?.noclulabsIdentityId).toBe(identity);
  });

  it("calls surface C with actingForSubject as the exact lowercase string true", async () => {
    const { identity } = await seedClaimed("u-acting");
    const { client, calls } = makeFakeScore();
    enableSummon(client);

    await summonRoute({ platform: "discord", platformUserId: "u-acting" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe(identity);
    // The exact lowercase literal, never a coerced or capitalized boolean.
    expect(calls[0]!.actingForSubject).toBe("true");
    expect(typeof calls[0]!.actingForSubject).toBe("string");
  });
});

describe("summon: not_linked (never seen and unclaimed unified)", () => {
  it("returns not_linked for a never-seen user and creates no participant", async () => {
    const { client, calls } = makeFakeScore();
    enableSummon(client);

    const response = await summonRoute({ platform: "discord", platformUserId: "u-never-seen" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("not_linked");
    // No surface C call, and no participant created by the read.
    expect(calls).toHaveLength(0);
    expect(await participantCount()).toBe(0);
  });

  it("returns not_linked for an unclaimed ghost without calling surface C", async () => {
    const created = await resolveP({ platform: "discord", platformUserId: "u-ghost" });
    const ghostId = created.json().data.participant.id as string;
    const { client, calls } = makeFakeScore();
    enableSummon(client);

    const response = await summonRoute({ platform: "discord", platformUserId: "u-ghost" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("not_linked");
    expect(calls).toHaveLength(0);
    // The ghost is untouched (still unlinked, only the one created).
    expect((await participantById(ghostId))?.noclulabsIdentityId).toBeNull();
    expect(await participantCount()).toBe(1);
  });
});

describe("summon: subject_gone (stale noclulabs link)", () => {
  it("returns subject_gone on unknown_subject and writes no participant state", async () => {
    const { participantId, identity } = await seedClaimed("u-stale");
    const { client, calls } = makeFakeScore(() => ({ kind: "unknown_subject" }));
    enableSummon(client);

    const response = await summonRoute({ platform: "discord", platformUserId: "u-stale" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.outcome).toBe("subject_gone");
    expect(calls).toHaveLength(1);

    // Read-only: the participant keeps its link and is NOT marked stale (the emit path
    // owns the stale-link marker, not the summon).
    const participant = await participantById(participantId);
    expect(participant?.noclulabsIdentityId).toBe(identity);
    expect(participant?.identityEmitDisabledAt).toBeNull();
  });
});

describe("summon: error mapping", () => {
  it("maps surface C invalid_request to a 500 internal (our request bug)", async () => {
    await seedClaimed("u-invalid");
    const { client } = makeFakeScore(() => ({ kind: "invalid_request" }));
    enableSummon(client);

    const response = await summonRoute({ platform: "discord", platformUserId: "u-invalid" });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("internal");
  });

  it("maps a thrown upstream error (401, 500, timeout, or network) to a 502", async () => {
    await seedClaimed("u-upstream");
    const kinds = ["unauthorized", "server_misconfigured", "unexpected_status", "network"] as const;
    for (const kind of kinds) {
      const { client } = makeFakeScore(() => {
        throw new NoclulabsClientError(kind, `simulated ${kind}`);
      });
      enableSummon(client);
      const response = await summonRoute({ platform: "discord", platformUserId: "u-upstream" });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe("upstream_error");
      resetSummonRuntimeForTest();
    }
  });
});

describe("summon: auth, gating, and validation", () => {
  it("returns 401 when the service token is missing", async () => {
    const { client, calls } = makeFakeScore();
    enableSummon(client);

    const response = await summonRoute({ platform: "discord", platformUserId: "u-auth" }, null);
    expect(response.statusCode).toBe(401);
    // The inbound gate runs before any resolution.
    expect(calls).toHaveLength(0);
  });

  it("returns 401 for a wrong service token", async () => {
    const { client, calls } = makeFakeScore();
    enableSummon(client);

    const response = await summonRoute({ platform: "discord", platformUserId: "u-auth2" }, "wrong-token");
    expect(response.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("returns 503 summon_disabled when the flag is off and never calls surface C", async () => {
    // Inject the client but leave enabled unset so it falls back to the config flag,
    // which is off in the test env.
    const { client, calls } = makeFakeScore();
    setSummonRuntimeForTest({ client, logger: silentLogger });
    await seedClaimed("u-disabled");

    const response = await summonRoute({ platform: "discord", platformUserId: "u-disabled" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("summon_disabled");
    expect(calls).toHaveLength(0);
  });

  it("returns 422 for a missing platformUserId", async () => {
    enableSummon(makeFakeScore().client);
    const response = await summonRoute({ platform: "discord" });
    expect(response.statusCode).toBe(422);
  });

  it("returns 422 for a platform absent from the registry", async () => {
    enableSummon(makeFakeScore().client);
    const response = await summonRoute({ platform: "telegram", platformUserId: "u-bad-platform" });
    expect(response.statusCode).toBe(422);
  });
});
