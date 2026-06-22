import { and, eq, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { communityMembers, moderationActions, platformAccounts } from "@/lib/db/schema/index.js";
import { ApiError } from "@/plugins/error-handler.js";

// The transaction handle drizzle passes to db.transaction(callback). Extracted
// from the callback parameter so the merge helpers run inside the caller's
// transaction, and so the row locks the claim acquires are held for the whole
// claim-and-merge.
export type DbTransaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

// A participant-owned relation: a table whose rows belong to a participant
// through one or more participant_id foreign keys. Each entry knows how to
// relocate its rows to a survivor and how to count the rows a participant still
// owns. Encapsulating each concrete table behind these methods keeps the list
// strongly typed (no heterogeneous-table union, no any).
//
// participantColumns names every foreign-key column on the table that references
// participants. Most tables have one (participant_id); moderation_actions has two
// (actor_participant_id and target_participant_id). The catalog assertion
// cross-checks this list against the Postgres catalog, so a table whose set of
// participant foreign keys ever drifts from what is declared (a new column, or a
// second column left out of the relocation) fails loud rather than silently
// dropping rows on a merge. relocate must move every column named here.
interface OwnedRelation {
  readonly name: string;
  readonly participantColumns: readonly string[];
  relocate(tx: DbTransaction, fromParticipantId: string, toParticipantId: string): Promise<void>;
  countOwned(tx: DbTransaction, participantId: string): Promise<number>;
}

// The later of two nullable timestamps, used when combining two inactive
// memberships: the survivor's left_at becomes whichever leave happened last. A
// null stands for "unknown", so the other value wins; two nulls stay null.
function laterTimestamp(a: Date | null, b: Date | null): Date | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return a.getTime() >= b.getTime() ? a : b;
}

// The single source of truth for a merge. Both the relocation step and the
// USER_HAS_DATA guard iterate this one list, so for every LISTED relation they
// stay in lockstep: a relation that is relocated is always also guarded, and one
// that is guarded is always also relocated. The guard therefore catches an
// incomplete relocation of a listed relation. It does NOT, by itself, catch a
// participant-owned table that was never added to this list: a participant_id
// foreign key with ON DELETE CASCADE would silently drop such rows when a ghost
// is deleted. Guarding against that omission is a discipline, enforced by the
// do-not-touch rule in CLAUDE.md and by the catalog assertion in the tests (which
// fails loud if a participant_id foreign-key table is missing from this list),
// not by this code at runtime.
//
// PHASE 4 EXTENSION: per-community XP and leveling (phase 4b) add their own
// participant-owned tables. Each MUST be added here the moment it gains a
// participant_id ON DELETE CASCADE, or a merge will silently drop a survivor's
// would-be rows. Adding an entry extends BOTH the relocation and the guard at
// once. See the USER_HAS_DATA invariant in CLAUDE.md.
export const PARTICIPANT_OWNED_RELATIONS: readonly OwnedRelation[] = [
  {
    name: "platform_accounts",
    participantColumns: ["participant_id"],
    async relocate(tx, fromParticipantId, toParticipantId) {
      // (platform, platform_user_id) is globally unique, so a single account
      // exists per key and re-pointing can never collide on the survivor.
      await tx
        .update(platformAccounts)
        .set({ participantId: toParticipantId })
        .where(eq(platformAccounts.participantId, fromParticipantId));
    },
    async countOwned(tx, participantId) {
      const rows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(platformAccounts)
        .where(eq(platformAccounts.participantId, participantId));
      return rows[0]?.count ?? 0;
    },
  },
  {
    name: "community_members",
    participantColumns: ["participant_id"],
    // Memberships cannot always re-point: the ghost and the survivor can each be
    // a member of the same community (a community that spans two platforms, with
    // the person active on both), and the unique (community_id, participant_id)
    // forbids two rows for the survivor in one community. So re-point where the
    // survivor is not yet a member, and combine where it is.
    async relocate(tx, fromParticipantId, toParticipantId) {
      const ghostMemberships = await tx
        .select()
        .from(communityMembers)
        .where(eq(communityMembers.participantId, fromParticipantId));

      for (const ghost of ghostMemberships) {
        const survivor = (
          await tx
            .select()
            .from(communityMembers)
            .where(
              and(
                eq(communityMembers.communityId, ghost.communityId),
                eq(communityMembers.participantId, toParticipantId),
              ),
            )
            .limit(1)
        )[0];

        if (survivor === undefined) {
          // No collision: re-point, preserving the row's created_at,
          // permission_level, active, and left_at. Each ghost membership is for a
          // distinct community (the unique key), so re-pointing one never creates
          // a collision for another in this loop.
          await tx
            .update(communityMembers)
            .set({ participantId: toParticipantId })
            .where(eq(communityMembers.id, ghost.id));
          continue;
        }

        // Collision: combine into the survivor's row, then drop the ghost's.
        // permission_level is the higher of the two; active is true if either is
        // active; left_at is null when the combined membership is active, else the
        // later of the two left_at values. The survivor's created_at is unchanged
        // (it is not in the set).
        const active = survivor.active || ghost.active;
        const permissionLevel = Math.max(survivor.permissionLevel, ghost.permissionLevel);
        const leftAt = active ? null : laterTimestamp(survivor.leftAt, ghost.leftAt);
        await tx
          .update(communityMembers)
          .set({ active, permissionLevel, leftAt })
          .where(eq(communityMembers.id, survivor.id));
        await tx.delete(communityMembers).where(eq(communityMembers.id, ghost.id));
      }
    },
    async countOwned(tx, participantId) {
      const rows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(communityMembers)
        .where(eq(communityMembers.participantId, participantId));
      return rows[0]?.count ?? 0;
    },
  },
  {
    name: "moderation_actions",
    // Two foreign keys to participants: a participant can be the actor of some log
    // rows and the target of others. A merge must re-point BOTH from the ghost to
    // the survivor, or the reference left behind would be dropped when the ghost
    // is deleted (the cascade) and would also trip the guard. There is no combine:
    // each row is an individual, immutable log entry, and re-pointing a
    // participant reference collides with nothing (no unique constraint on these
    // columns), so the relocation is a straight update of each column where it
    // equals the ghost. A row where the ghost is both actor and target has both
    // columns moved to the survivor by the two updates.
    participantColumns: ["actor_participant_id", "target_participant_id"],
    async relocate(tx, fromParticipantId, toParticipantId) {
      await tx
        .update(moderationActions)
        .set({ actorParticipantId: toParticipantId })
        .where(eq(moderationActions.actorParticipantId, fromParticipantId));
      await tx
        .update(moderationActions)
        .set({ targetParticipantId: toParticipantId })
        .where(eq(moderationActions.targetParticipantId, fromParticipantId));
    },
    async countOwned(tx, participantId) {
      const rows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(moderationActions)
        .where(
          or(
            eq(moderationActions.actorParticipantId, participantId),
            eq(moderationActions.targetParticipantId, participantId),
          ),
        );
      return rows[0]?.count ?? 0;
    },
  },
];

// Move every participant-owned row from one participant to another. The merge
// calls this to relocate a ghost's rows onto the survivor before the ghost is
// deleted.
export async function relocateOwnedRows(
  tx: DbTransaction,
  fromParticipantId: string,
  toParticipantId: string,
): Promise<void> {
  for (const relation of PARTICIPANT_OWNED_RELATIONS) {
    await relation.relocate(tx, fromParticipantId, toParticipantId);
  }
}

// The USER_HAS_DATA guard: the tripwire that no participant with owned data is
// ever deleted in a merge. Run after relocation and before the delete. If the
// loser still owns any row in any participant-owned relation, the relocation set
// is incomplete, so abort the merge (throwing rolls back the whole transaction).
// This is an internal invariant breach (a programming error), hence a 500.
export async function assertParticipantOwnsNothing(
  tx: DbTransaction,
  participantId: string,
): Promise<void> {
  for (const relation of PARTICIPANT_OWNED_RELATIONS) {
    const remaining = await relation.countOwned(tx, participantId);
    if (remaining > 0) {
      throw new ApiError(
        "USER_HAS_DATA",
        `merge aborted: participant ${participantId} still owns ${remaining} ${relation.name} row(s) after relocation`,
        500,
      );
    }
  }
}
