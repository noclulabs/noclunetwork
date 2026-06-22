import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/index.js";
import { requireRow } from "@/lib/db/helpers.js";
import { moderationActions } from "@/lib/db/schema/index.js";
import type { ModerationActionName } from "@/lib/registry/moderation-actions.js";
import type { Platform } from "@/lib/registry/platforms.js";
import { resolveParticipant } from "@/services/participants/resolve.js";
import { resolveCommunity } from "@/services/communities/resolve.js";
import { deactivateMembershipRow } from "@/services/memberships/lifecycle.js";
import {
  computeSanctionState,
  shapeAction,
  type ModerationActionView,
  type SanctionState,
} from "./sanction-state.js";

// The maximum length of a moderation reason. A reason is a short note, not a
// document; the bound keeps the column from being used as free storage.
export const MAX_REASON_LENGTH = 1000;

// The maximum duration of a temporary mute or ban, in seconds (ten years). A
// positive integer up to this bound is accepted; zero, negative, or anything
// larger is rejected as absurd, well below the point an interval would overflow.
export const MAX_DURATION_SECONDS = 315_360_000;

export interface RecordModerationActionInput {
  platform: Platform;
  platformGroupId: string;
  actorPlatformUserId: string;
  targetPlatformUserId: string;
  action: ModerationActionName;
  reason?: string;
  durationSeconds?: number;
}

export interface RecordModerationActionResult {
  action: ModerationActionView;
  sanctionState: SanctionState;
}

// The actions whose membership effect is to remove the target from the community
// by soft-leaving an existing membership. A kick removes with no lasting
// sanction; a ban removes and sets the banned state.
const REMOVES_MEMBERSHIP: ReadonlySet<ModerationActionName> = new Set(["kick", "ban"]);

// The actions that carry a duration. expires_at is set (now plus the requested
// duration) only for a temporary mute or ban; for any other action, or a mute or
// ban with no durationSeconds, it stays null (indefinite, or not applicable).
const SUPPORTS_DURATION: ReadonlySet<ModerationActionName> = new Set(["mute", "ban"]);

// Record one moderation event reported by a trusted bot and apply its effect. The
// bot has already enforced platform-side moderator permission; the core records
// the actor it reports and does not interpret permission_level (native
// authorization is deferred by design). The community, the actor, and the target
// are resolve-or-created first (each in its own transaction, reusing the phase 2
// paths and their race handling) so a ban can target a member who has never
// posted. Then, in one transaction, the log row is appended and the membership
// effect applied atomically, and the target's resulting sanction state is derived
// from that same transaction so it reflects the event just appended.
//
// No retry loop is needed: the insert carries a uuidv7 primary key and conflicts
// with nothing, the only lock is the FOR UPDATE on the single membership row a
// kick or ban deactivates (a block, never a deadlock cycle under READ COMMITTED),
// and the derive is a read. Duplicate at-least-once deliveries simply append
// duplicate events, which the derived state tolerates.
export async function recordModerationAction(
  input: RecordModerationActionInput,
): Promise<RecordModerationActionResult> {
  const db = getDb();
  const {
    platform,
    platformGroupId,
    actorPlatformUserId,
    targetPlatformUserId,
    action,
    reason,
    durationSeconds,
  } = input;

  const resolvedCommunity = await resolveCommunity({ platform, platformGroupId });
  const resolvedActor = await resolveParticipant({ platform, platformUserId: actorPlatformUserId });
  const resolvedTarget = await resolveParticipant({
    platform,
    platformUserId: targetPlatformUserId,
  });
  const communityId = resolvedCommunity.community.id;
  const actorParticipantId = resolvedActor.participant.id;
  const targetParticipantId = resolvedTarget.participant.id;

  const setExpiry = SUPPORTS_DURATION.has(action) && durationSeconds !== undefined;
  // now() plus the duration, computed in the database so expires_at and the
  // created_at it is later measured against share one clock. make_interval keeps
  // the duration a bound parameter, never string-interpolated into SQL.
  const expiresAt: SQL | null = setExpiry
    ? sql`now() + make_interval(secs => ${durationSeconds})`
    : null;

  return db.transaction(async (tx) => {
    const inserted = requireRow(
      await tx
        .insert(moderationActions)
        .values({
          communityId,
          actorParticipantId,
          targetParticipantId,
          action,
          reason: reason ?? null,
          expiresAt,
        })
        .returning(),
      "insert moderation_actions",
    );

    // kick and ban remove the target from the community by soft-leaving any
    // existing membership (the shared 4a leave path, run in this transaction so
    // the log row and the deactivation commit together). A ban can target a
    // non-member, in which case there is no membership to deactivate and this is
    // an idempotent no-op. Neither ever creates a membership.
    if (REMOVES_MEMBERSHIP.has(action)) {
      await deactivateMembershipRow(tx, communityId, targetParticipantId);
    }

    const sanctionState = await computeSanctionState(tx, communityId, targetParticipantId);
    return { action: shapeAction(inserted), sanctionState };
  });
}
