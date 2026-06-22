import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/index.js";
import { isRetryableTransactionError, isUniqueViolation, requireRow } from "@/lib/db/helpers.js";
import { participants, platformAccounts } from "@/lib/db/schema/index.js";
import { ApiError } from "@/plugins/error-handler.js";
import type { Platform } from "@/lib/registry/platforms.js";
import { resolveParticipant } from "./resolve.js";
import {
  assertParticipantOwnsNothing,
  relocateOwnedRows,
  type DbTransaction,
} from "./owned-relations.js";

export interface ClaimParticipantInput {
  platform: Platform;
  platformUserId: string;
  noclulabsIdentityId: string;
}

export type ClaimOutcome = "claimed" | "already_linked" | "merged";

export interface ClaimResult {
  participant: {
    id: string;
    noclulabsIdentityId: string | null;
    createdAt: Date;
  };
  outcome: ClaimOutcome;
  // Set only when outcome is "merged": the id of the removed ghost.
  mergedParticipantId?: string;
}

type ParticipantRow = typeof participants.$inferSelect;

// A claim-in-place can lose a race for the identity to a concurrent claim of a
// different platform account (the participants.noclulabs_identity_id unique
// constraint). On that unique violation we re-run: the loser now sees the
// identity held by another participant and takes the merge path instead. We also
// re-run on a transient serialization failure or deadlock (see the locking note
// in runClaim). Two attempts always suffice for the unique-violation case (a
// merge never inserts the identity); the small bound also absorbs transient retries.
const MAX_CLAIM_ATTEMPTS = 3;

function shape(participant: ParticipantRow, outcome: ClaimOutcome): ClaimResult {
  return {
    participant: {
      id: participant.id,
      noclulabsIdentityId: participant.noclulabsIdentityId,
      createdAt: participant.createdAt,
    },
    outcome,
  };
}

// A claim is the verification of a platform account against a noclulabs identity,
// so every claim outcome leaves the account verified. Flip it only when needed,
// to avoid an unnecessary updated_at bump.
async function markVerified(
  tx: DbTransaction,
  accountId: string,
  alreadyVerified: boolean,
): Promise<void> {
  if (alreadyVerified) {
    return;
  }
  await tx
    .update(platformAccounts)
    .set({ verified: true })
    .where(eq(platformAccounts.id, accountId));
}

// The claim-and-merge body, run inside one transaction. The five cases are
// documented inline. P is the participant the claimed account currently points
// to; S is the participant that already holds the identity (the merge survivor),
// if any.
async function runClaim(
  tx: DbTransaction,
  platform: string,
  platformUserId: string,
  identityId: string,
): Promise<ClaimResult> {
  // Lock the platform account row first: it is the stable anchor for this claim.
  // The account is never deleted (only re-pointed or flipped to verified), so
  // locking it serializes every concurrent claim of the same (platform,
  // platformUserId). The participant it points to may be re-pointed (a merge) or
  // deleted (the ghost), so the participant is always derived from the locked
  // account, never used as the lock anchor.
  const account = requireRow(
    await tx
      .select()
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.platform, platform),
          eq(platformAccounts.platformUserId, platformUserId),
        ),
      )
      .for("update")
      .limit(1),
    "lock platform_accounts for claim",
  );

  // The participant that already holds this identity (the merge survivor), if
  // any. The noclulabs_identity_id unique constraint guarantees at most one.
  const holder = (
    await tx
      .select({ id: participants.id })
      .from(participants)
      .where(eq(participants.noclulabsIdentityId, identityId))
      .limit(1)
  )[0];

  // Lock P (the account's participant) and S (the holder) together, requesting
  // them in ascending id order. The account row lock above is the true serializer
  // for same-key claims (the only real contention); this participant lock is
  // defense in depth for cross-key merges into the same survivor and gives the
  // guard a consistent read. Postgres does not strictly guarantee lock-acquisition
  // order under ORDER BY plus FOR UPDATE, so a deadlock is not impossible in
  // theory (it is, in practice, since merges share at most the single survivor
  // row); if one ever occurs it rolls back and the caller retries it as a
  // transient error rather than returning a 500.
  const idsToLock = Array.from(
    new Set([account.participantId, holder?.id].filter((id): id is string => id !== undefined)),
  ).sort();
  const lockedRows = await tx
    .select()
    .from(participants)
    .where(inArray(participants.id, idsToLock))
    .orderBy(asc(participants.id))
    .for("update");
  const byId = new Map(lockedRows.map((row) => [row.id, row]));

  const p = byId.get(account.participantId);
  if (p === undefined) {
    // The account is locked, so its participant cannot vanish under us.
    throw new ApiError("INTERNAL_ERROR", "claim could not load the account participant", 500);
  }
  const s = holder ? byId.get(holder.id) : undefined;

  // Case 2: already linked to this identity. Idempotent; ensure verified.
  if (p.noclulabsIdentityId === identityId) {
    await markVerified(tx, account.id, account.verified);
    return shape(p, "already_linked");
  }

  // Case 3: linked to a different identity. A platform account belongs to one
  // identity; re-assignment is out of scope for this phase. Reject, change nothing.
  if (p.noclulabsIdentityId !== null) {
    throw new ApiError(
      "ACCOUNT_ALREADY_VERIFIED",
      "this platform account is already verified to a different identity",
      409,
    );
  }

  // P is a ghost from here (noclulabs_identity_id is null).

  // Case 5: a different participant (S) already holds the identity. Merge the
  // ghost into S: relocate the ghost's owned rows onto S, verify the claimed
  // account, run the USER_HAS_DATA guard, then delete the ghost. The survivor is
  // always the identity-bearer.
  if (s !== undefined) {
    await relocateOwnedRows(tx, p.id, s.id);
    await markVerified(tx, account.id, account.verified);
    await assertParticipantOwnsNothing(tx, p.id);
    await tx.delete(participants).where(eq(participants.id, p.id));
    return { ...shape(s, "merged"), mergedParticipantId: p.id };
  }

  // Case 4: claim in place. No participant holds the identity yet, so link the
  // ghost to it and verify the account.
  const claimed = requireRow(
    await tx
      .update(participants)
      .set({ noclulabsIdentityId: identityId })
      .where(eq(participants.id, p.id))
      .returning(),
    "claim participant identity in place",
  );
  await markVerified(tx, account.id, account.verified);
  return shape(claimed, "claimed");
}

// Verification-driven claim-and-merge. A claim asserts that (platform,
// platformUserId) is verified as belonging to a noclulabs identity. The whole
// operation is transactional, idempotent, and serialized by the account row lock.
// Case 1 (the account has never been seen) is handled by the resolve-or-create
// below before the claim transaction runs; the remaining four cases are in
// runClaim. The survivor of a merge is always the participant that already
// carries the identity.
export async function claimParticipant(input: ClaimParticipantInput): Promise<ClaimResult> {
  const db = getDb();
  const { platform, platformUserId, noclulabsIdentityId } = input;

  // Case 1 precondition: a verification can arrive before the person has ever
  // posted, so ensure the platform account (and its ghost participant) exist.
  // Reuses the phase 2 resolve-or-create path (idempotent and race-safe).
  await resolveParticipant({ platform, platformUserId });

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction((tx) =>
        runClaim(tx, platform, platformUserId, noclulabsIdentityId),
      );
    } catch (error) {
      // A lost race for the identity (a concurrent claim-in-place of a different
      // account took it) surfaces as a unique violation; re-run so the loser
      // takes the merge path. A transient serialization failure or deadlock is
      // also safe to re-run (the transaction already rolled back). Any other
      // error, or an exhausted budget, propagates.
      const retryable = isUniqueViolation(error) || isRetryableTransactionError(error);
      if (retryable && attempt < MAX_CLAIM_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }

  // Unreachable: the loop returns on success and rethrows on the final attempt.
  throw new ApiError("INTERNAL_ERROR", "claim did not converge", 500);
}
