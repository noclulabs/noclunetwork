import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/index.js";
import { requireRow } from "@/lib/db/helpers.js";
import { participants } from "@/lib/db/schema/index.js";
import { getRedis } from "@/lib/redis/index.js";
import { levelForXp } from "@/lib/leveling/index.js";
import type { Platform } from "@/lib/registry/platforms.js";
import { ensureMembership, type MembershipView } from "@/services/memberships/lifecycle.js";

// The flat XP granted on a qualifying engagement. A domain-tuning constant kept in
// one place, not per-deploy configuration.
export const XP_PER_GRANT = 20;

// The per-community cooldown window, in seconds. A second qualifying engagement
// from the same participant in the same community inside this window grants
// nothing. The window is per community, so a participant active in several
// communities accrues from each independently (the point of an internet of
// communities).
export const COOLDOWN_SECONDS = 60;

export interface RecordEngagementInput {
  platform: Platform;
  platformUserId: string;
  platformGroupId: string;
  platformUsername?: string;
}

export interface RecordEngagementResult {
  participant: { id: string; networkXp: number; networkLevel: number };
  membership: MembershipView;
  // The grant fired on this call (false when the cooldown gated it).
  granted: boolean;
  // The grant crossed a level boundary.
  leveledUp: boolean;
  // The level before this grant, present only when leveledUp.
  previousLevel?: number;
}

// The cooldown key lives in the single ncn: namespace (the prefix is applied by
// the Redis client, not spelled here). It is keyed by the resolved community and
// participant ids, so the gate is per (community, participant) and independent
// across communities.
function cooldownKey(communityId: string, participantId: string): string {
  return `engagement:cooldown:${communityId}:${participantId}`;
}

// Try to claim the grant for this (community, participant) with SET NX EX: set the
// key only if absent, with the cooldown window as its TTL. The call that sets the
// key (reply "OK") wins the grant; a call that finds it already set (reply null)
// is inside the cooldown and grants nothing. SET NX is the atomic gate, so two
// simultaneous engagements for the same member grant XP exactly once.
async function tryClaimGrant(communityId: string, participantId: string): Promise<boolean> {
  const reply = await getRedis().set(
    cooldownKey(communityId, participantId),
    "1",
    "EX",
    COOLDOWN_SECONDS,
    "NX",
  );
  return reply === "OK";
}

// Record an engagement reported by a bot. The bot reports a trackable interaction
// and the core decides the grant (thin adapter, fat core). First compose the phase
// 4a ensure-membership so the participant, the community, and the membership exist
// (reusing that path and its own race handling). Then accrue lifetime network XP,
// gated by the per-community cooldown: a grant increments network_xp atomically
// and reports the new total, the new level, and any level-up; a call inside the
// cooldown is a no-op that still reports the current total and level.
export async function recordEngagement(
  input: RecordEngagementInput,
): Promise<RecordEngagementResult> {
  const db = getDb();
  const { platform, platformUserId, platformGroupId, platformUsername } = input;

  const ensured = await ensureMembership({
    platform,
    platformUserId,
    platformGroupId,
    platformUsername,
  });
  const participantId = ensured.participant.id;
  const communityId = ensured.community.id;

  const granted = await tryClaimGrant(communityId, participantId);

  if (!granted) {
    // Cooldown no-op: nothing changes. Read the current total to report the level.
    const current = requireRow(
      await db
        .select({ networkXp: participants.networkXp })
        .from(participants)
        .where(eq(participants.id, participantId))
        .limit(1),
      "read participant network_xp",
    );
    return {
      participant: {
        id: participantId,
        networkXp: current.networkXp,
        networkLevel: levelForXp(current.networkXp),
      },
      membership: ensured.membership,
      granted: false,
      leveledUp: false,
    };
  }

  // Grant: increment network_xp atomically in a single UPDATE, returning the new
  // total. The new level derives from the returned total; the previous level from
  // the total minus this grant; a level-up is when the new level exceeds it.
  const updated = requireRow(
    await db
      .update(participants)
      .set({ networkXp: sql`${participants.networkXp} + ${XP_PER_GRANT}` })
      .where(eq(participants.id, participantId))
      .returning({ networkXp: participants.networkXp }),
    "increment participant network_xp",
  );
  const networkXp = updated.networkXp;
  const networkLevel = levelForXp(networkXp);
  const previousLevel = levelForXp(networkXp - XP_PER_GRANT);
  const leveledUp = networkLevel > previousLevel;

  return {
    participant: { id: participantId, networkXp, networkLevel },
    membership: ensured.membership,
    granted: true,
    leveledUp,
    ...(leveledUp ? { previousLevel } : {}),
  };
}
