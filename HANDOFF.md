# HANDOFF.md

Overwrite this file in full at the end of every session. Never append. Hard cap 4,000 characters. Last updated: 2026-07-02.

## Last Session Shipped

2026-07-02, docs/rampup-handoff-bible-files: added the RAMPUP.md and HANDOFF.md bible files and wired the HANDOFF.md discipline into CLAUDE.md. The previous session's merged PR was #14 (reconciled the deployment records with the aligned compose). This session's own PR number is not known at write time, the branch identifies it.

## Current State

Phase 5, the bidirectional noCluID bridge, is complete on the noCluNetwork side and deployed live in production as of 2026-06-30. Verify, emit, and reconcile are enabled and verified live in both directions (stages 0 through 2 of the DEPLOYMENT.md go-live runbook). Summon (stage 3) is built but disabled, deferred pending noCluBot. Phases 1 through 4 (bootstrap, data-model foundation, claim-and-merge, and the community engagement core) shipped earlier; see CHANGELOG.md. There is no public route today: all bridge traffic is outbound over the private Docker network, and the committed compose matches the deployed configuration (reconciled in PRs #13 and #14).

## Next Up

Phase 6, the noCluBot arc: bootstrap the noCluBot monorepo (a separate repo), the Discord adapter, and the OpenAPI-generated client, then the summon-your-noCluID surfacing commands. On deck in this repo, per the ROADMAP.md operational follow-ups: the calendar-semver tagging pass (the repository is untagged and package.json is at 0.0.0), and hardening the migration mechanics plus codifying the doadmin privilege grants into a deploy script (the DEPLOYMENT.md known follow-ups).

## Open Questions / Blockers

None.

## Temporary Warnings

SUMMON_ENABLED is off in production by design (pending noCluBot); the other three bridge flags are on. The earliest production rows are stage 2 verification artifacts, not organic activity. DEPLOYMENT.md notes the negative-test guard run (bad inbound token, unknown subject, malformed acting-for-subject, the non-owner privacy default) is still pending to close verification.
