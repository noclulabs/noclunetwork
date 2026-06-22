import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDb } from "@/lib/db/index.js";
import { communityPlatforms, moderationActions, platformAccounts } from "@/lib/db/schema/index.js";
import type { ModerationActionName } from "@/lib/registry/moderation-actions.js";
import type { Platform } from "@/lib/registry/platforms.js";
import type { DbTransaction } from "@/services/participants/owned-relations.js";

// A read or derive can run on the plain db (the standalone reads) or inside a
// transaction (the action route, which derives the resulting state from the same
// transaction that just inserted the new event, so it sees that event).
type Executor = NodePgDatabase | DbTransaction;

// The shared view of one moderation_actions row, returned by the action route and
// the history read. The log is content-immutable, so this is a faithful echo of a
// stored row.
export interface ModerationActionView {
  id: string;
  communityId: string;
  actorParticipantId: string;
  targetParticipantId: string;
  action: ModerationActionName;
  reason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

type ModerationActionRow = typeof moderationActions.$inferSelect;

export function shapeAction(row: ModerationActionRow): ModerationActionView {
  return {
    id: row.id,
    communityId: row.communityId,
    actorParticipantId: row.actorParticipantId,
    targetParticipantId: row.targetParticipantId,
    // action is free-form text in the column but only ever written through the
    // registry-validated route, so it is a registry action name on read.
    action: row.action as ModerationActionName,
    reason: row.reason,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

// The derived sanction state for a member in a community. Computed at read from
// the log, never stored. until is the active sanction's expires_at when it is a
// timed sanction, and null for an indefinite active sanction or no sanction.
export interface SanctionState {
  muted: boolean;
  mutedUntil: Date | null;
  banned: boolean;
  bannedUntil: Date | null;
}

const CLEARED_STATE: SanctionState = {
  muted: false,
  mutedUntil: null,
  banned: false,
  bannedUntil: null,
};

// The four action names that drive sanction state. warn and kick leave no
// derived state (a warning is advisory; a kick has no lasting sanction), so they
// are not consulted here.
const SANCTION_ACTIONS = ["mute", "unmute", "ban", "unban"] as const;

interface LatestEvent {
  expiresAt: Date | null;
  createdAt: Date;
}

// Resolve one sanction (mute or ban) from the latest applying event and the
// latest reversing event. The sanction is active when the application is more
// recent than its reversal (or there is no reversal) AND it has not expired (a
// null expires_at is indefinite, a future one is still active, a past one has
// lapsed). A reversal at or after the application clears it.
function resolveSanction(
  applied: LatestEvent | undefined,
  reversed: LatestEvent | undefined,
  now: number,
): { active: boolean; until: Date | null } {
  if (applied === undefined) {
    return { active: false, until: null };
  }
  if (reversed !== undefined && reversed.createdAt.getTime() >= applied.createdAt.getTime()) {
    return { active: false, until: null };
  }
  if (applied.expiresAt !== null && applied.expiresAt.getTime() <= now) {
    return { active: false, until: null };
  }
  return { active: true, until: applied.expiresAt };
}

// Compute the derived sanction state for (community, target) from the log. One
// query pulls the latest event of each sanction action (DISTINCT ON action,
// newest first), served by the (target, community, created_at desc) index, then
// the two sanctions are resolved in memory. now is read once so a single call is
// internally consistent.
export async function computeSanctionState(
  executor: Executor,
  communityId: string,
  targetParticipantId: string,
): Promise<SanctionState> {
  const rows = await executor
    .selectDistinctOn([moderationActions.action], {
      action: moderationActions.action,
      expiresAt: moderationActions.expiresAt,
      createdAt: moderationActions.createdAt,
    })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.targetParticipantId, targetParticipantId),
        eq(moderationActions.communityId, communityId),
        inArray(moderationActions.action, [...SANCTION_ACTIONS]),
      ),
    )
    .orderBy(moderationActions.action, desc(moderationActions.createdAt));

  const latest = new Map<string, LatestEvent>(
    rows.map((row) => [row.action, { expiresAt: row.expiresAt, createdAt: row.createdAt }]),
  );
  const now = Date.now();
  const mute = resolveSanction(latest.get("mute"), latest.get("unmute"), now);
  const ban = resolveSanction(latest.get("ban"), latest.get("unban"), now);
  return {
    muted: mute.active,
    mutedUntil: mute.until,
    banned: ban.active,
    bannedUntil: ban.until,
  };
}

interface MemberRefs {
  participantId: string;
  communityId: string;
}

// Resolve a (platform, platformGroupId, platformUserId) to its participant and
// community ids WITHOUT creating anything. A read never mints rows: a member or
// community that was never seen simply has no sanction history. Returns null when
// either the platform account or the community mapping is absent.
async function resolveMemberRefs(
  platform: string,
  platformGroupId: string,
  platformUserId: string,
): Promise<MemberRefs | null> {
  const db = getDb();

  const account = (
    await db
      .select({ participantId: platformAccounts.participantId })
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.platform, platform),
          eq(platformAccounts.platformUserId, platformUserId),
        ),
      )
      .limit(1)
  )[0];
  if (account === undefined) {
    return null;
  }

  const communityPlatform = (
    await db
      .select({ communityId: communityPlatforms.communityId })
      .from(communityPlatforms)
      .where(
        and(
          eq(communityPlatforms.platform, platform),
          eq(communityPlatforms.platformGroupId, platformGroupId),
        ),
      )
      .limit(1)
  )[0];
  if (communityPlatform === undefined) {
    return null;
  }

  return { participantId: account.participantId, communityId: communityPlatform.communityId };
}

export interface MemberRefInput {
  platform: Platform;
  platformGroupId: string;
  platformUserId: string;
}

// Read the current sanction state for a member without creating anything. A
// member or community that does not exist has no sanctions, so the cleared state
// is returned.
export async function getSanctionState(input: MemberRefInput): Promise<SanctionState> {
  const refs = await resolveMemberRefs(
    input.platform,
    input.platformGroupId,
    input.platformUserId,
  );
  if (refs === null) {
    return { ...CLEARED_STATE };
  }
  return computeSanctionState(getDb(), refs.communityId, refs.participantId);
}

// The default and maximum history page size. The log grows without bound, so the
// page size is capped to keep a single read bounded.
export const DEFAULT_HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE_SIZE = 100;

export interface ModerationHistoryInput extends MemberRefInput {
  page: number;
  pageSize: number;
}

export interface ModerationHistoryResult {
  actions: ModerationActionView[];
  total: number;
}

// Read a member's moderation history (the actions where they are the target) in a
// community, newest first, paginated. The log grows without bound, so pagination
// is required; the page slice and the total are both scoped to (target,
// community) and served by the (target, community, created_at desc) index. A
// member or community that does not exist has an empty history.
export async function getModerationHistory(
  input: ModerationHistoryInput,
): Promise<ModerationHistoryResult> {
  const refs = await resolveMemberRefs(
    input.platform,
    input.platformGroupId,
    input.platformUserId,
  );
  if (refs === null) {
    return { actions: [], total: 0 };
  }

  const db = getDb();
  const where = and(
    eq(moderationActions.targetParticipantId, refs.participantId),
    eq(moderationActions.communityId, refs.communityId),
  );

  const totalRow = (
    await db.select({ count: sql<number>`count(*)::int` }).from(moderationActions).where(where)
  )[0];
  const total = totalRow?.count ?? 0;

  const rows = await db
    .select()
    .from(moderationActions)
    .where(where)
    .orderBy(desc(moderationActions.createdAt))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);

  return { actions: rows.map(shapeAction), total };
}
