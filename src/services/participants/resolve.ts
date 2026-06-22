import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/index.js";
import { isUniqueViolation, requireRow } from "@/lib/db/helpers.js";
import { participants, platformAccounts } from "@/lib/db/schema/index.js";
import type { Platform } from "@/lib/registry/platforms.js";

export interface ResolveParticipantInput {
  platform: Platform;
  platformUserId: string;
  platformUsername?: string;
}

export interface ResolvedParticipant {
  participant: {
    id: string;
    noclulabsIdentityId: string | null;
    createdAt: Date;
  };
  platformAccount: {
    id: string;
    platform: string;
    platformUserId: string;
    verified: boolean;
    isPrimary: boolean;
  };
  created: boolean;
}

type Db = ReturnType<typeof getDb>;

interface AccountWithParticipant {
  participant: typeof participants.$inferSelect;
  account: typeof platformAccounts.$inferSelect;
}

async function findAccount(
  db: Db,
  platform: string,
  platformUserId: string,
): Promise<AccountWithParticipant | undefined> {
  const rows = await db
    .select({ participant: participants, account: platformAccounts })
    .from(platformAccounts)
    .innerJoin(participants, eq(participants.id, platformAccounts.participantId))
    .where(
      and(
        eq(platformAccounts.platform, platform),
        eq(platformAccounts.platformUserId, platformUserId),
      ),
    )
    .limit(1);
  return rows[0];
}

function shape(found: AccountWithParticipant, created: boolean): ResolvedParticipant {
  return {
    participant: {
      id: found.participant.id,
      noclulabsIdentityId: found.participant.noclulabsIdentityId,
      createdAt: found.participant.createdAt,
    },
    platformAccount: {
      id: found.account.id,
      platform: found.account.platform,
      platformUserId: found.account.platformUserId,
      verified: found.account.verified,
      isPrimary: found.account.isPrimary,
    },
    created,
  };
}

// Resolve-or-create a participant from a platform user id, idempotent on
// (platform, platform_user_id). An existing account returns its participant; a
// new one creates a ghost participant (noclulabs_identity_id null, nothing is
// verified or linked in this phase) plus its first platform account (is_primary
// true, verified false) in one transaction. The create is race-safe: if a
// concurrent call won the unique key, the transaction rolls back on the unique
// violation and the existing record is re-resolved.
export async function resolveParticipant(
  input: ResolveParticipantInput,
): Promise<ResolvedParticipant> {
  const db = getDb();
  const { platform, platformUserId, platformUsername } = input;

  const existing = await findAccount(db, platform, platformUserId);
  if (existing) {
    if (
      platformUsername !== undefined &&
      existing.account.platformUsername !== platformUsername
    ) {
      const updated = await db
        .update(platformAccounts)
        .set({ platformUsername })
        .where(eq(platformAccounts.id, existing.account.id))
        .returning();
      existing.account = requireRow(updated, "update platform_accounts username");
    }
    return shape(existing, false);
  }

  try {
    const created = await db.transaction(async (tx) => {
      const insertedParticipant = requireRow(
        await tx.insert(participants).values({}).returning(),
        "insert participants",
      );
      const insertedAccount = requireRow(
        await tx
          .insert(platformAccounts)
          .values({
            participantId: insertedParticipant.id,
            platform,
            platformUserId,
            platformUsername: platformUsername ?? null,
            isPrimary: true,
            verified: false,
          })
          .returning(),
        "insert platform_accounts",
      );
      return { participant: insertedParticipant, account: insertedAccount };
    });
    return shape(created, true);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await findAccount(db, platform, platformUserId);
      if (raced) {
        return shape(raced, false);
      }
    }
    throw error;
  }
}
