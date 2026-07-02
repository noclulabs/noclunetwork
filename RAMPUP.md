# RAMPUP.md

Architect entry point for noCluNetwork. A fresh architect session reads this file plus HANDOFF.md, nothing else, to ramp.

## Project Identity

noCluNetwork is the noClu estate's cross-platform community-engagement engine: a Fastify Core API that runs communities, membership, leveling, and moderation across chat platforms, resolves platform accounts to noClu identities, and acts as the bidirectional bridge between platform bots and noCluID (authenticity signals up to the noclulabs.com ledger, scoped identity data back down). It is a relying party of noclulabs.com, never an auth or identity issuer, and it never computes its own authenticity score.

## File Map

- CLAUDE.md: project context, the suite model, conventions, invariants, gotchas, current-state pointer.
- README.md: public-facing overview, setup, stack, project structure, deployment notes.
- ROADMAP.md: phase plan, the rebuild arc, north stars, deferred items. Authoritative for phase status.
- CHANGELOG.md: shipped history in Keep a Changelog format.
- DEPLOYMENT.md: production deployment runbook and operational record (topology, database, go-live stages, gotchas).
- RAMPUP.md: this file, the stable architect entry point and pointer manifest.
- HANDOFF.md: the volatile session baton, rewritten in full every session.

## Architect Ramp-Up Procedure

1. Read this file.
2. Read HANDOFF.md for current state, next unit of work, and any warnings.
3. Do NOT read CLAUDE.md, README.md, ROADMAP.md, or CHANGELOG.md at ramp-up. Pull specific files on demand only when the task requires them.

## Executor Session Shape

1. Sync: git status, git fetch, git checkout main, git pull, verify clean.
2. Ramp: read CLAUDE.md, README.md, ROADMAP.md, CHANGELOG.md, HANDOFF.md.
3. Execute one unit of work per the prompt.
4. Update the relevant bible files and rewrite HANDOFF.md in full.
5. Open a PR, report, stop.

## Process Rules

Branch plus PR, no direct pushes to main, Robert squash-merges. Conventional Commits. Kebab-case branch names. No em dashes anywhere. Rewriting HANDOFF.md is part of every session's definition of done. Full detail lives in CLAUDE.md.
