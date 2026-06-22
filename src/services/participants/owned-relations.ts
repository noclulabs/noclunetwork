import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { platformAccounts } from "@/lib/db/schema/index.js";
import { ApiError } from "@/plugins/error-handler.js";

// The transaction handle drizzle passes to db.transaction(callback). Extracted
// from the callback parameter so the merge helpers run inside the caller's
// transaction, and so the row locks the claim acquires are held for the whole
// claim-and-merge.
export type DbTransaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

// A participant-owned relation: a table whose rows belong to exactly one
// participant. Each entry knows how to relocate its rows to a survivor and how to
// count the rows a participant still owns. Encapsulating each concrete table
// behind these two methods keeps the list strongly typed (no heterogeneous-table
// union, no any).
interface OwnedRelation {
  readonly name: string;
  relocate(tx: DbTransaction, fromParticipantId: string, toParticipantId: string): Promise<void>;
  countOwned(tx: DbTransaction, participantId: string): Promise<number>;
}

// The single source of truth for a merge. Both the relocation step and the
// USER_HAS_DATA guard iterate this one list, so for every LISTED relation they
// stay in lockstep: a relation that is relocated is always also guarded, and one
// that is guarded is always also relocated. The guard therefore catches an
// incomplete relocation of a listed relation. It does NOT, by itself, catch a
// participant-owned table that was never added to this list: a participant_id
// foreign key with ON DELETE CASCADE would silently drop such rows when a ghost
// is deleted. Guarding against that omission is a discipline, enforced by the
// do-not-touch rule below and in CLAUDE.md, not by this code.
//
// PHASE 4 EXTENSION (required): when community memberships and per-community XP
// land, add their tables here (community_members, then the XP and leveling
// tables). community_members already has a participant_id ON DELETE CASCADE, so
// it MUST be added the moment it gains a write path, or a merge will silently
// drop a survivor's would-be memberships. Adding an entry extends BOTH the
// relocation and the guard at once. See the USER_HAS_DATA invariant in CLAUDE.md.
export const PARTICIPANT_OWNED_RELATIONS: readonly OwnedRelation[] = [
  {
    name: "platform_accounts",
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
