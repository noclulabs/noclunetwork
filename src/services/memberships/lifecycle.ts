import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/index.js";
import { isRetryableTransactionError, isUniqueViolation, requireRow } from "@/lib/db/helpers.js";
import { communityMembers, communityPlatforms, platformAccounts } from "@/lib/db/schema/index.js";
import { ApiError } from "@/plugins/error-handler.js";
import type { Platform } from "@/lib/registry/platforms.js";
import { resolveParticipant } from "@/services/participants/resolve.js";
import { resolveCommunity } from "@/services/communities/resolve.js";
import type { DbTransaction } from "@/services/participants/owned-relations.js";

// The shared membership view returned by both lifecycle operations. left_at is
// null while the membership is active.
export interface MembershipView {
  id: string;
  communityId: string;
  participantId: string;
  active: boolean;
  permissionLevel: number;
  createdAt: Date;
  leftAt: Date | null;
}

type MembershipRow = typeof communityMembers.$inferSelect;

function shapeMembership(row: MembershipRow): MembershipView {
  return {
    id: row.id,
    communityId: row.communityId,
    participantId: row.participantId,
    active: row.active,
    permissionLevel: row.permissionLevel,
    createdAt: row.createdAt,
    leftAt: row.leftAt,
  };
}

export interface EnsureMembershipInput {
  platform: Platform;
  platformUserId: string;
  platformGroupId: string;
  platformUsername?: string;
  communityName?: string;
}

export interface EnsureMembershipResult {
  participant: { id: string; noclulabsIdentityId: string | null; createdAt: Date };
  community: { id: string; name: string; createdAt: Date };
  membership: MembershipView;
  // The membership row was created on this call.
  created: boolean;
  // An inactive membership (a prior leave) was reactivated on this call.
  reactivated: boolean;
}

// A first-time ensure of the same (community, participant) can race a concurrent
// one on the unique key; the loser rolls back and re-runs, finding the winner's
// row. The small bound also absorbs a transient serialization failure or deadlock.
// Two attempts always suffice for the unique-violation case (the second run sees
// the committed row and no-ops or reactivates).
const MAX_ENSURE_ATTEMPTS = 3;

interface EnsureRowOutcome {
  membership: MembershipView;
  created: boolean;
  reactivated: boolean;
}

// Ensure a single membership row for (communityId, participantId) inside the
// caller's transaction. The row is locked FOR UPDATE so a concurrent leave or
// ensure of the same membership serializes behind this one. No row yet: create it
// (active, permission_level 0). An inactive row (a prior leave): reactivate in
// place, preserving the row, its created_at, and its permission_level. An active
// row: a true no-op (no write, so updated_at is left untouched).
async function ensureMembershipRow(
  tx: DbTransaction,
  communityId: string,
  participantId: string,
): Promise<EnsureRowOutcome> {
  const existing = (
    await tx
      .select()
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.participantId, participantId),
        ),
      )
      .for("update")
      .limit(1)
  )[0];

  if (existing) {
    if (existing.active) {
      return { membership: shapeMembership(existing), created: false, reactivated: false };
    }
    const reactivated = requireRow(
      await tx
        .update(communityMembers)
        .set({ active: true, leftAt: null })
        .where(eq(communityMembers.id, existing.id))
        .returning(),
      "reactivate community_members",
    );
    return { membership: shapeMembership(reactivated), created: false, reactivated: true };
  }

  const inserted = requireRow(
    await tx
      .insert(communityMembers)
      .values({ communityId, participantId, active: true, permissionLevel: 0 })
      .returning(),
    "insert community_members",
  );
  return { membership: shapeMembership(inserted), created: true, reactivated: false };
}

// Ensure a participant is a member of a community, resolving both from platform
// ids. Composes the phase 2 resolve-or-create paths (each idempotent and
// race-safe in its own transaction): a never-seen user becomes a ghost, a
// never-seen group becomes a community. The resolves run before the membership
// transaction on purpose: each resolve catches its own unique-violation and
// re-resolves, which only works if that violation rolls back its own transaction
// rather than poisoning an outer one. The membership step is then transactional
// and race-safe in the same idempotent, retry-on-unique-violation style.
export async function ensureMembership(
  input: EnsureMembershipInput,
): Promise<EnsureMembershipResult> {
  const db = getDb();
  const { platform, platformUserId, platformGroupId, platformUsername, communityName } = input;

  const resolvedParticipant = await resolveParticipant({
    platform,
    platformUserId,
    platformUsername,
  });
  const resolvedCommunity = await resolveCommunity({
    platform,
    platformGroupId,
    name: communityName,
  });
  const participantId = resolvedParticipant.participant.id;
  const communityId = resolvedCommunity.community.id;

  for (let attempt = 0; attempt < MAX_ENSURE_ATTEMPTS; attempt += 1) {
    try {
      const outcome = await db.transaction((tx) =>
        ensureMembershipRow(tx, communityId, participantId),
      );
      return {
        participant: resolvedParticipant.participant,
        community: resolvedCommunity.community,
        membership: outcome.membership,
        created: outcome.created,
        reactivated: outcome.reactivated,
      };
    } catch (error) {
      const retryable = isUniqueViolation(error) || isRetryableTransactionError(error);
      if (retryable && attempt < MAX_ENSURE_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }

  // Unreachable: the loop returns on success and rethrows on the final attempt.
  throw new ApiError("INTERNAL_ERROR", "ensure membership did not converge", 500);
}

export interface LeaveMembershipInput {
  platform: Platform;
  platformUserId: string;
  platformGroupId: string;
}

export interface LeaveMembershipResult {
  // True only when this call transitioned an active membership to inactive.
  left: boolean;
  // The resulting membership state, or null when there was nothing to leave (no
  // participant, community, or membership for the given ids).
  membership: MembershipView | null;
}

// Leave a community: mark the membership inactive (active false, left_at now).
// The participant and the community are resolved WITHOUT creating them, because
// leaving something that was never joined is an idempotent no-op success, not an
// error. A missing participant, community, or membership, or an already-inactive
// membership, all return left false.
export async function leaveMembership(
  input: LeaveMembershipInput,
): Promise<LeaveMembershipResult> {
  const db = getDb();
  const { platform, platformUserId, platformGroupId } = input;

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
    return { left: false, membership: null };
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
    return { left: false, membership: null };
  }

  return db.transaction(async (tx) => {
    const existing = (
      await tx
        .select()
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, communityPlatform.communityId),
            eq(communityMembers.participantId, account.participantId),
          ),
        )
        .for("update")
        .limit(1)
    )[0];

    if (existing === undefined) {
      return { left: false, membership: null };
    }
    if (!existing.active) {
      return { left: false, membership: shapeMembership(existing) };
    }

    const updated = requireRow(
      await tx
        .update(communityMembers)
        .set({ active: false, leftAt: sql`now()` })
        .where(eq(communityMembers.id, existing.id))
        .returning(),
      "leave community_members",
    );
    return { left: true, membership: shapeMembership(updated) };
  });
}
