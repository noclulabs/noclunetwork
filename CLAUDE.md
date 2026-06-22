# CLAUDE.md

> Project context file for Claude Code sessions. Read this file first, every session.

## Project overview

noCluNetwork is the noClu estate's cross-platform community-engagement engine. It is a Fastify Core API that runs communities, membership, leveling, and moderation across chat platforms, resolves platform accounts to noClu identities, and acts as the bidirectional bridge between those platforms and noCluID. It is a relying party of noclulabs.com, never an auth or identity issuer.

- Repository: github.com/noclulabs/noCluNetwork
- Role: the community engine, plus the bridge between platform bots and noCluID
- Hosting: Docker on the shared noClu DigitalOcean droplet behind Caddy (host port 3000)
- Status: bootstrapped scaffold. ROADMAP.md is authoritative for phase status; CHANGELOG.md holds the full history.

This is the rebuild of the legacy portalNetwork Core API and bot suite. The old code was mined for a spec, not integrated. The legal entity stays portalNetwork Inc.; the product and the repo are noCluNetwork.

## The noClu suite model

noclulabs.com is the estate's auth issuer and identity core (it owns Auth.js, noCluID, and the append-only `identity_signals` ledger). Every other product is its own repo and a relying party that federates auth from it. noCluNetwork is one such product.

Two facts govern everything noCluNetwork does:

1. noCluNetwork federates auth and defers identity to noclulabs.com. It does not run its own auth, sessions, password storage, or OAuth2 provider, and it does not compute its own authenticity score. Identity, the dual authenticity score, and connection visibility all live in noCluID.

2. noCluNetwork is the bidirectional bridge between platforms and noCluID:
   - Write: it emits append-only authenticity signals up to the noCluID ledger (the intake contract). noCluNetwork is the ledger's first real writer.
   - Read: it reads scoped noCluID data back down (the read contract) so a bot can surface a user's identity on the platform they are standing in.

The other repos in the estate:

- noclulabs.com (exists): the auth, identity, and signal-ledger hub. The integration contracts (federation, intake, read) are governed by its AUTH-PLAYBOOK.md and IDENTITY-PLAYBOOK.md. Read those when a phase touches federation or the noCluID contract.
- noCluBot (separate repo, later): the multi-platform bot monorepo. A pure HTTP client of noCluNetwork over the service-token contract. It holds all platform adapters (Discord first) plus a shared adapter core, and it generates its typed client from noCluNetwork's OpenAPI spec.
- noCluCal (exists): the calendar product, a parallel relying party. Independent of noCluNetwork.

Repo-per-product is the rule. Each repo is born under the noclulabs org with its own four bible files.

## Bible files (canonical set)

Four bible files in the repo root are the source of truth for project state and the continuity mechanism between sessions. Claude Code reads CLAUDE.md, README.md, and ROADMAP.md in full at the start of every session, plus the `[Unreleased]` section of CHANGELOG.md (not its full released history; consult that on demand). Per-feature playbooks are added as subsystems grow and are read when the work touches that area.

| File | When updated | Owns |
|------|-------------|------|
| CLAUDE.md | Per-PR when an invariant, convention, gotcha, or current-state pointer changes | Project context, the suite model, stack, conventions, invariants, gotchas, current-state pointer, do-not-touch rules |
| CHANGELOG.md | Every PR, no exceptions | Change history in Keep a Changelog format under [Unreleased] with Added, Changed, Fixed, Removed, plus the tagged release history |
| ROADMAP.md | Per-PR when phase status changes, an arc is fleshed out, or a deferred item is logged or resolved | Phase plan, the rebuild arc, north stars, deferred items |
| README.md | When user-facing capability, setup, or the stack change | Public-facing overview, setup, project structure, deployment notes |

CLAUDE.md holds invariants and pointers, not narrative (that is CHANGELOG) and not deep per-feature mechanics (those go in playbooks as they are added). Instruction-following degrades as the file grows, so 40k characters is the soft ceiling every PR that touches the file must leave it under. When an addition would breach the ceiling or add narrative or deep mechanics, relocate (history to CHANGELOG, mechanics to a playbook) rather than grow the file.

Every executor prompt begins by reading the bibles and ends with a "Bible file updates (REQUIRED)" section naming the files and the edits. A PR that ships work without a CHANGELOG entry is drift the next session must fix. If a session finds drift or bloat, it surfaces it at the start and proposes an in-place fix (small) or a dedicated reclamation PR (large).

## Tech stack

- Language: TypeScript, strict mode (no `any`, no `@ts-ignore`).
- Runtime: Node 22 LTS.
- API: Fastify, with `@fastify/cors`, `@fastify/rate-limit`, and `@fastify/swagger` plus swagger-ui (the OpenAPI spec is the contract noCluBot's client is generated from).
- Database: PostgreSQL 18 via Drizzle ORM (`pg` driver). Drizzle, not Prisma. The old code used Prisma; the estate standardizes on Drizzle for one ORM across products and the shared registry-as-canonical discipline (see the Database conventions below and noclulabs.com's DATABASE-PLAYBOOK.md).
- Cache, pub/sub, queues: Redis via ioredis, plus BullMQ (a separate ioredis instance for BullMQ to avoid the version-mismatch issue).
- Validation: Zod. Logging: Pino. Testing: Vitest.
- Package manager: pnpm. The old monorepo used npm; the estate standardizes on pnpm. noCluNetwork is a single application, not a workspace (a workspace is introduced only if a shared internal package is later warranted).
- Deployment: Docker on the shared noClu droplet behind Caddy (host port 3000), the same TLS-terminating reverse proxy that fronts noclulabs.com (3001) and noCluCal (3002). CI and CD via GitHub Actions.

## Architectural invariants (load-bearing, do not drift)

1. Relying party, not issuer. Federate auth from noclulabs.com; never reimplement authentication, sessions, password storage, JWT issuance, or an OAuth2 provider. This is the whole reason for the rebuild. In the headless first scope, federation is service-to-service (see invariant 9). Browser-cookie suite SSO (AUTH_SECRET parity, the parent-domain cookie) applies only to a future noCluNetwork web portal, not the Core API.

2. Thin adapter, fat core. All business logic lives in noCluNetwork. Bots are pure HTTP clients over the service-token contract and run no business logic. The repo split (bots in noCluBot) makes this boundary physical: a bot cannot import core internals, only call the API.

3. Identity defers to noCluID. noCluNetwork keys platform accounts to noclulabs identities; it does not mint users and does not compute a second authenticity score. The dual authenticity score (true versus public) and the three connection visibility levels live in noCluID. noCluNetwork emits signals and reads scores; it never recomputes or stores an authenticity number.

4. The bidirectional bridge enforces privacy at the source. The noCluNetwork to noclulabs.com channel carries the intake write (append-only signals) and the scoped read (noCluID data for surfacing). The read API on noclulabs.com applies the dual-score and visibility model itself: the true score is owner-only and is only ever returned for the authenticated subject about themselves, never about another user, and bots deliver it privately (an ephemeral reply on Discord, a direct message where a platform has no ephemerals). The public score is the only shareable one. noCluNetwork and the bots never make a privacy decision and cannot leak; they render what the privacy-aware contract returns.

5. The verification linchpin. A platform account maps to a noclulabs identity only through a verified noCluID connection (a `connections` row on noclulabs.com with `provider = <platform>` and `provider_account_id = <platform user id>`). That single verification unlocks both directions: attributing the user's platform activity up as signals, and surfacing their noCluID back down. Discord as a noCluID provider is therefore a required noclulabs.com-side piece of this arc. Ghost accounts (auto-created from platform activity, not yet linked to a noclulabs identity) are the un-attributed state; a verification triggers claim-and-merge.

6. Registry-as-canonical. No DB metadata table and no foreign key onto registry ids; the TypeScript registry is the sole source of truth for the things it owns (signal types and their weights, qualifier definitions, and similar), with integrity enforced at the application layer. There is nothing to seed for those. This mirrors noclulabs.com.

7. Append-only ledgers and audit. The signal stream and any currency ledger ($IOC if kept) are append-only with a running snapshot, never mutated in place. Moderation and antispam outcomes are negative signals.

8. One Redis namespace from the first commit. The old code drifted across `pn:`, `cd:`, `xp_cd:`, `rl:`, `as:`, `user:`, and others. Unify on a single prefix (`ncn:`) for every key, everywhere.

9. Two service credentials. The service token (`X-Service-Token` plus `X-Service-Name`) authenticates bots to noCluNetwork. A separate trusted credential authenticates noCluNetwork to noclulabs.com for the intake and read contracts. Platform tokens (Discord and so on) live only in noCluBot, never in noCluNetwork.

## Conventions

### Code style
- TypeScript strict; no `any`, no `@ts-ignore`. Named exports; default export only where a framework requires it.
- Files kebab-case. A path alias maps to the source root.
- Each service owns its domain logic; routes are thin wrappers that parse, delegate, and render the response envelope.
- Response envelope: `{ success, data?, error?: { code, message }, pagination? }`, with a typed error class and a Fastify error handler. A serialization hook converts any BigInt to Number for JSON.

### Writing style
- No em dashes, anywhere, ever. Use commas, periods, or parentheses.
- Sentence case for headings and labels. No emoji. No exclamation marks. Plain, direct language. Minimal copy.

### Git conventions
- Conventional Commits: `type(scope): description`. Types: feat, fix, docs, refactor, test, chore, build, ci, perf, style, revert. Imperative mood, lowercase after the colon, no trailing period, under 72 chars.
- Branch naming: kebab-case, phase-named when part of a defined phase, otherwise descriptive with a prefix (`feat/`, `fix/`, `chore/`, `docs/`, `refactor/`).
- Squash merge to main.
- Versioning: calendar-semver `YYYY.MAJOR.MINOR.PATCH` (for example `2026.1.0.0`), applied as a git tag after merge, not committed as a file change. Tag when a meaningful unit ships, not every PR.

### Database (Drizzle)
- Schema in one file per table (kebab-case), with co-located inferred types. Migrations are append-only: never edit a migration applied to production, write a new one. Generate after editing schema files, apply locally before pushing.
- Drizzle does not auto-generate `CREATE EXTENSION` statements or triggers; any migration that needs them is hand-edited, the same way noclulabs.com does it.
- Production database access SSL workaround: every `DATABASE_URL` used by node-pg, drizzle-orm, or drizzle-kit must end with `&uselibpqcompat=true`, or the driver attempts `sslmode=verify-full` and fails against DigitalOcean's self-signed cert with `SELF_SIGNED_CERT_IN_CHAIN`. `psql` does not need the suffix. This is the same gotcha documented in noclulabs.com's DATABASE-PLAYBOOK.md.

### The OpenAPI contract
- noCluNetwork publishes an OpenAPI spec via `@fastify/swagger`. That spec is the contract noCluBot generates its typed client from, so it cannot silently drift. Keep route schemas accurate; the spec is a deliverable, not a side effect.

## Current state

Bootstrapped scaffold: the Fastify Core API with a `GET /health` route and the response envelope, Drizzle wired with an empty migrations setup, Zod-validated config, the Redis client on the `ncn:` namespace, the service-auth plugin, the OpenAPI spec, and the CI gate. No domain logic yet. ROADMAP.md is authoritative for phase status and the planned arc; CHANGELOG.md holds the history.

## Gotchas and do-not-touch

- Do not add native auth, password storage, a JWT issuer, or an OAuth2 provider. Identity and auth defer to noclulabs.com (invariants 1 and 3).
- Do not put business logic in a bot or let a bot reach any datastore directly. Bots call the API (invariant 2).
- Do not compute or store an authenticity score in noCluNetwork. Emit signals, read scores (invariant 3).
- Do not return a true score for anyone other than the authenticated subject, and do not let a bot surface owner-only data in a public context (invariant 4).
- Do not split the Redis namespace; one prefix (invariant 8).
- Do not drop the `&uselibpqcompat=true` suffix from a production `DATABASE_URL`.

## The git-sync-first rule (from PR 2 on)

Every executor prompt after the bootstrap opens with the git sync sequence (status, fetch, checkout main, pull, status) before any other Mac command. The bootstrap PR is the one exception, because the repo does not exist until it runs.
