# noCluNetwork

The cross-platform community-engagement engine for the noClu estate. A Fastify Core API that runs communities and acts as the bridge between platform bots and noCluID. Built with TypeScript, Fastify, PostgreSQL via Drizzle, and Redis.

## What it is

noCluNetwork runs the community layer of the noClu network: communities, membership, per-community and network leveling, and moderation across chat platforms. It resolves platform accounts (a Discord user, for example) to noClu identities, and it is the bidirectional bridge to noCluID:

- It emits authenticity signals up to the noCluID ledger on noclulabs.com, so a user's activity across communities strengthens their identity.
- It reads scoped noCluID data back down, so a bot can surface a user's identity on the platform they are standing in.

It is a relying party of noclulabs.com, the noClu estate's auth issuer and identity core. noCluNetwork does not run its own auth, sessions, or authenticity scoring; those live in noclulabs.com and noCluID. This is the rebuild of the legacy portalNetwork Core API, built fresh from a spec rather than ported.

## Role in the suite

- noclulabs.com: the auth, identity, and signal-ledger hub. Everything federates auth from it.
- noCluNetwork (this repo): the community engine and the bridge between platform bots and noCluID.
- noCluBot: the multi-platform bot monorepo, a pure client of noCluNetwork's API.
- noCluCal: the calendar product, a parallel relying party.

## Stack

- TypeScript (strict mode), Node 22
- Fastify (with CORS, rate-limit, and OpenAPI via @fastify/swagger)
- PostgreSQL 18 via Drizzle ORM
- Redis via ioredis (cache, pub/sub, BullMQ)
- Zod (validation), Pino (logging), Vitest (testing)
- pnpm (package manager)
- Docker on a DigitalOcean droplet behind Caddy
- GitHub Actions (CI and CD)

## Getting started

### Prerequisites

- Node.js 22+
- pnpm 10
- Docker (for local Postgres and Redis)

### Setup

```bash
git clone https://github.com/noclulabs/noclunetwork.git
cd noclunetwork
pnpm install
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
pnpm db:migrate
pnpm dev
```

### Commands

```bash
pnpm dev            # start the dev server
pnpm build          # production build
pnpm start          # start the production server
pnpm lint           # run ESLint
pnpm type-check     # TypeScript type checking
pnpm test           # run Vitest
pnpm db:generate    # generate a Drizzle migration from the schema files
pnpm db:migrate     # apply pending migrations to the local database
pnpm db:studio      # browse the local database
```

## Project structure

After bootstrap. Run `git ls-files` for the full tree.

```
src/
  index.ts                  # runtime entry point (invokes start)
  server.ts                 # Fastify app factory, the /api/v1 mount, and the start routine
  config.ts                 # Zod-validated config (with the production DATABASE_URL guard)
  plugins/                  # Fastify plugins (service auth, error handler, swagger, verify-sync and emit-reconcile schedulers)
  routes/
    health.ts               # liveness probe (rate-limit exempt)
    participants.ts         # POST /api/v1/participants/resolve and /claim
    communities.ts          # POST /api/v1/communities/resolve
    memberships.ts          # POST /api/v1/memberships/ensure and /leave
    engagement.ts           # POST /api/v1/engagement (accrue network XP)
    moderation.ts           # POST /api/v1/moderation/actions, GET /moderation/state and /history
    summon.ts               # POST /api/v1/summon (read an invoking user's noCluID score, read-down)
    parse.ts                # Zod body parse into an ApiError (400 by default, 422 for summon)
  services/
    participants/
      resolve.ts            # resolve-or-create a participant
      claim.ts              # verification-driven claim-and-merge (sums network_xp on merge)
      owned-relations.ts    # participant-owned relations (platform_accounts, community_members, moderation_actions): merge relocation and the USER_HAS_DATA guard
    communities/resolve.ts  # resolve-or-create a community
    memberships/lifecycle.ts # ensure-membership, leave, and the shared soft-leave (rejoin on ensure)
    engagement/grant.ts     # record an engagement: cooldown-gated network XP grant
    moderation/
      actions.ts            # record a moderation action and apply its membership effect
      sanction-state.ts     # the derived-at-read sanction state and the two reads
    verify-sync/            # the inbound verify poller: reads surface B, drives the claim, durable watermark
      poller.ts             # the factory: runIncrementalCycle and runFullRescan (gap-closure)
      watermark.ts          # the Postgres-backed watermark store
      streams.ts            # the stream-key and provider constants
    emit-sync/              # the outbound emit: push the leveling contribution to surface A (best-effort, post-commit)
      emit.ts               # the orchestration: gate, skip ghost/stale, compute contribution, emit, set the stale marker
      claim-and-emit.ts     # the shared claim-and-emit wrapper (the single emit trigger for claim and merge)
      reconcile.ts          # the reconcile backstop: a stateless full pass re-emitting every claimed participant
    summon/                 # the inbound read-down: resolve a user read-only, read surface C, map to an outcome
      summon.ts             # the service: read-only resolution, the single surface C call, the outcome mapping
  lib/
    db/
      index.ts              # the pg pool and the Drizzle connection
      helpers.ts            # requireRow and the unique-violation guard
      schema/               # one file per table, re-exported from index.ts
    leveling/               # the polynomial XP-to-level curve and the capped contribution (pure)
    redis/                  # ioredis client on the single ncn: namespace (the engagement cooldown)
    noclulabs/              # the noclulabs.com integration boundary (authed client, verified-connections, signals, and score ports)
    registry/
      platforms.ts          # the platform registry (canonical valid platforms)
      moderation-actions.ts # the moderation action registry (canonical valid actions)
  types/                    # shared types and the response envelope
drizzle/migrations/         # append-only migrations (0000 foundational, 0001 membership active and left_at, 0002 participant network_xp, 0003 the moderation_actions table, 0004 the sync_watermarks table, 0005 the participant identity_emit_disabled_at marker)
test/
  constants.ts              # shared test env defaults (database, Redis, service token)
  global-setup.ts           # creates the test database and applies migrations once
  helpers/db.ts             # truncate-between-tests isolation
  config.test.ts            # the production DATABASE_URL guard
  db/data-model.test.ts     # DB-backed migration and resolve-route tests
  db/claim-and-merge.test.ts # claim-and-merge cases, USER_HAS_DATA, concurrency
  db/membership-lifecycle.test.ts # ensure, leave, rejoin, the merge relocation, concurrency
  db/owned-relations-catalog.test.ts # asserts every participant_id foreign-key table is registered
  db/engagement.test.ts     # engagement grant, the per-community cooldown, cross-community, concurrency
  db/moderation.test.ts     # moderation actions and effects, derived sanction state, the reads, the two-key merge
  db/verify-sync.test.ts    # the poller against a fake surface B: cycle, pagination, gap-closure, failure-no-advance
  verify-sync-config.test.ts # the verify-sync config additions, the enable refine, and the scheduler gate
  db/emit-sync.test.ts      # the emit triggers against a fake signals client: level-up gate, claim and merge, best-effort, stale marker, gating
  emit-sync-config.test.ts  # the emit config additions and the enable refine
  db/emit-reconcile.test.ts # the reconcile pass against a fake signals client: re-emit, dedup no-op, pagination, skips, isolation, stale marker, statelessness
  emit-reconcile-config.test.ts # the reconcile config additions, the enable refine, and the two-flag scheduler gate
  db/summon.test.ts         # the summon endpoint against a fake score client: claimed, not_linked, subject_gone, error mapping, auth, disabled, validation
  score-client.test.ts      # the real score client against a spied fetch: the acting-for-subject wire literal, the bearer, the 200/422/401/network parses
  summon-config.test.ts     # the summon config addition, the enable refine, and the boolean validation
  leveling.test.ts          # the pure curve and contribution functions (unit, no DB)
Dockerfile
docker-compose.yml
docker-compose.dev.yml
```

## The bridge: verify-sync poller

noCluNetwork is the bidirectional bridge between platform bots and noCluID. The first realized piece of that bridge on this side is the verify-sync poller: a background poller that reads verified Discord connections from noclulabs.com (surface B of the bridge contract) and drives the existing participant claim for each one, linking ghost participants to their noCluID. It depends on a typed client interface, so the test suite runs fully offline against synthetic connections; live operation is pending the Discord OAuth app and the shared service token.

The poller ships inert. It is registered in the app but does nothing until enabled, so merging it changes nothing in production. Enable it by setting the environment variables below (config load fails fast if the poller is enabled without the noclulabs.com base URL and token):

| Variable | Default | Purpose |
|----------|---------|---------|
| `VERIFY_SYNC_ENABLED` | `false` | The primary gate. Accepts only `true` or `false`. While false the scheduler starts no timers and touches neither the database nor the network. |
| `VERIFY_SYNC_INTERVAL_MS` | `60000` | The fast-path incremental poll cadence. |
| `VERIFY_SYNC_RESCAN_INTERVAL_MS` | `3600000` | The full re-scan cadence (the gap-closure sweep, slower than the fast path). |
| `VERIFY_SYNC_PAGE_SIZE` | `200` | The page size requested from surface B (1 to 500; the server clamps to its maximum). |
| `NOCLULABS_BASE_URL` | (unset) | The noclulabs.com base URL. Required when the poller is enabled; in production the private VPC address. |
| `NOCLULABS_SERVICE_TOKEN` | (unset) | The trusted credential for calling noclulabs.com. Required when the poller is enabled. Sent as a bearer, never logged. |
| `NOCLULABS_HTTP_TIMEOUT_MS` | `10000` | The outbound request timeout for every call to noclulabs.com. |

The watermark (how far the poller has consumed each stream) is durable in Postgres (`sync_watermarks`), not Redis; the single `ncn:` Redis namespace stays reserved for the engagement cooldown.

## The bridge: emit client

The outbound half of the bridge is the emit client. When a claimed participant's network level changes, noCluNetwork pushes their capped leveling contribution up to noclulabs.com's signal intake (surface A of the bridge contract, `POST /api/identity/signals`). It is the ledger's first real writer from this side. The value is `min(level, 50) / 50`, the same capped contribution the leveling module derives; the True Score itself is computed on noclulabs.com from the signal ledger, never here.

Three events emit, always after the relevant transaction commits, never inside it: an engagement level-up (only when the integer level actually crosses, not on every XP gain), a claim, and a merge. The emit is best-effort: a failed emit never fails an engagement, a claim, a merge, or a poller cycle. If noclulabs.com reports the subject was deleted (`unknown_subject`), a nullable `identity_emit_disabled_at` marker on the participant (the 0005 migration) permanently stops emitting for that subject; a malformed-request error (`invalid_request`) is treated as a bug to fix and never disables the subject. The emit depends on a typed `SignalsClient` interface, so the test suite runs fully offline against a fake; live operation is pending the shared service token and the private base URL.

The emit ships inert, like the poller. Enable it with the flag below (config load fails fast if it is enabled without the noclulabs.com base URL and token, which it reuses from the poller):

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMIT_SYNC_ENABLED` | `false` | The gate. Accepts only `true` or `false`. While false no triggering event emits and nothing touches the network. |
| `NOCLULABS_BASE_URL` | (unset) | Reused from the poller. Required when the emit is enabled; in production the private VPC address. |
| `NOCLULABS_SERVICE_TOKEN` | (unset) | Reused from the poller. Required when the emit is enabled. Sent as a bearer, never logged. |
| `NOCLULABS_HTTP_TIMEOUT_MS` | `10000` | Reused from the poller. The outbound request timeout for every call to noclulabs.com. |

## The bridge: emit reconcile backstop

The on-event emit can miss in two ways: an emit lost while noclulabs.com was unreachable, and a crash between a committed transaction and its best-effort emit. The reconcile backstop closes both. It is a scheduled, stateless full pass that re-emits every claimed participant's current contribution through the same emit orchestration, so anything the on-event path failed to land eventually lands. It adds no schema (it reuses the `identity_emit_disabled_at` stale-link marker from the 0005 migration) and keeps no watermark: every cycle is a fresh full pass.

A full re-emit is cheap because noclulabs.com conditionally appends: re-emitting a participant who is already current writes nothing and returns `written` false, so a full pass corrects only the contributions that never landed. The pass is keyset-paginated in bounded batches (it never loads all participants at once), best-effort per participant (one participant's emit failure does not stop the pass), and stops a cycle only on a query or database error, which the next interval retries from the beginning.

The reconcile requires the on-event emit: it re-emits through the same orchestration and the same signals client, so the scheduler starts only when both `EMIT_SYNC_ENABLED` and `EMIT_RECONCILE_ENABLED` are true. It ships inert like the emit and the poller, and the suite runs fully offline against the same fake `SignalsClient`; live operation is pending the shared service token and the private base URL.

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMIT_RECONCILE_ENABLED` | `false` | The gate. Accepts only `true` or `false`. The scheduler starts only when this and `EMIT_SYNC_ENABLED` are both true; while either is false nothing reconciles and nothing touches the network. |
| `EMIT_RECONCILE_INTERVAL_MS` | `21600000` | The full-pass cadence (six hours), much slower than the poll. |
| `EMIT_RECONCILE_BATCH_SIZE` | `200` | The keyset page size for the pass (1 to 1000); the pass never loads all participants at once. |
| `NOCLULABS_BASE_URL` | (unset) | Reused from the poller and the emit. Required when the reconcile is enabled; in production the private VPC address. |
| `NOCLULABS_SERVICE_TOKEN` | (unset) | Reused from the poller and the emit. Required when the reconcile is enabled. Sent as a bearer, never logged. |

## The bridge: summon endpoint

The read-down half of the bridge is the summon endpoint, the last of the three noCluNetwork-side bridge capabilities. A user verifies a platform once, and that platform's bot becomes a window onto their noCluID. `POST /api/v1/summon` resolves an invoking platform user to their claimed participant, read-only (never creating a participant), and reads that subject's noCluID score from noclulabs.com (surface C of the bridge contract, `GET /api/identity/score`), returning the true score and the public score for the bot to present. The score-read client depends on a typed `ScoreClient` interface, so the test suite runs fully offline; live operation is pending the shared service token and the private base URL.

The request body is `{ platform, platformUserId }`. The response is the standard envelope. A defined business outcome is a 200 carrying a `data.outcome` discriminator:

- `ok`: `data` carries `subject`, `trueScore`, and `publicScore` (each a `{ total, breakdown }`). The true score and the public score both come from the single surface C call.
- `not_linked`: the invoking user has no platform account, or is an unclaimed ghost (no noCluID identity). The two sub-cases are unified.
- `subject_gone`: the noclulabs.com identity was deleted (surface C reported `unknown_subject`).

Infrastructure and upstream failures are non-200 so they surface loudly: 500 (`internal`) for our own bad request to surface C or an unexpected error, 502 (`upstream_error`) for a surface C 401, 500, timeout, or network failure, 503 (`summon_disabled`) when the feature flag is off, and 422 for a malformed body.

Two credentials, kept distinct: the endpoint is gated inbound by the service-auth plugin (a bot presents `X-Service-Token` plus `X-Service-Name` to call noCluNetwork); noCluNetwork then presents the separate outbound credential (`NOCLULABS_SERVICE_TOKEN`, a bearer) to call surface C. A missing or bad inbound service token is a 401, always required and independent of the feature flag.

Presentation is noCluBot's job: the Discord bot command and its private (ephemeral or DM) delivery of the owner-only true score live in noCluBot (a future repo). This endpoint is the unit noCluBot calls. The summon ships inert: with `SUMMON_ENABLED` false the endpoint returns 503 and never calls surface C, so merging it changes nothing in production.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SUMMON_ENABLED` | `false` | The endpoint gate. Accepts only `true` or `false`. While false the endpoint returns 503 `summon_disabled` and never calls surface C. |
| `NOCLULABS_BASE_URL` | (unset) | Reused from the poller and the emit. Required when the summon is enabled; in production the private VPC address. |
| `NOCLULABS_SERVICE_TOKEN` | (unset) | Reused from the poller and the emit. The outbound credential, distinct from the inbound `SERVICE_TOKEN`. Required when the summon is enabled. Sent as a bearer, never logged. |
| `NOCLULABS_HTTP_TIMEOUT_MS` | `10000` | Reused from the poller and the emit. The outbound request timeout for every call to noclulabs.com. |

## Bible files

This project uses four bible files as the continuity mechanism across Claude Code sessions:

| File | Purpose |
|------|---------|
| CLAUDE.md | Project context, the suite model, conventions, invariants, and pointers; read in full every session |
| README.md | This file: setup and overview |
| ROADMAP.md | The rebuild arc and forward plan |
| CHANGELOG.md | Shipped history in Keep a Changelog format |

Per-feature playbooks are added as subsystems grow.

## Deployment

Runs in Docker on the shared noClu DigitalOcean droplet behind Caddy, which terminates TLS and reverse-proxies each suite container (noCluNetwork on host port 3000, noclulabs.com on 3001, noCluCal on 3002). Bots authenticate to the API with a service token. noCluNetwork authenticates to noclulabs.com with a separate trusted credential for the intake and read contracts. Platform tokens live only in noCluBot.

## License

Private. All rights reserved.
