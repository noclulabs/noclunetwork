import {
  claimParticipant,
  type ClaimParticipantInput,
  type ClaimResult,
} from "@/services/participants/claim.js";
import { emitParticipantContribution } from "./emit.js";

// The single emit trigger point for claim and merge. The claim service is invoked
// from two places (the claim route and the verify-sync poller), so both go through
// this one wrapper rather than duplicating the emit trigger.
//
// The wrapper performs the claim, then, after the claim transaction has committed
// (claimParticipant resolves only on commit), runs the emit orchestration on the
// resulting participant: a ghost newly linked in place, a participant confirmed
// already linked, or a merge survivor whose summed network_xp may have changed its
// level. The server dedups an unchanged value, so the unconditional emit is safe.
//
// It preserves the poller's robustness exactly. emitParticipantContribution never
// throws, so the only thing that can propagate out of this wrapper is a claim error
// (a 409 conflict, or a transient serialization or database error). The claim error
// path is therefore unchanged: the poller still sees and handles it with its
// page-atomic, failure-no-advance retry, and a failing emit never alters the
// poller's advance behavior.
export async function claimAndEmit(input: ClaimParticipantInput): Promise<ClaimResult> {
  const result = await claimParticipant(input);
  await emitParticipantContribution(result.participant.id);
  return result;
}
