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
  plugins/                  # Fastify plugins (service auth, error handler, swagger)
  routes/
    health.ts               # liveness probe (rate-limit exempt)
    participants.ts         # POST /api/v1/participants/resolve and /claim
    communities.ts          # POST /api/v1/communities/resolve
    memberships.ts          # POST /api/v1/memberships/ensure and /leave
    engagement.ts           # POST /api/v1/engagement (accrue network XP)
    moderation.ts           # POST /api/v1/moderation/actions, GET /moderation/state and /history
    parse.ts                # Zod body parse into a 400 ApiError
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
  lib/
    db/
      index.ts              # the pg pool and the Drizzle connection
      helpers.ts            # requireRow and the unique-violation guard
      schema/               # one file per table, re-exported from index.ts
    leveling/               # the polynomial XP-to-level curve and the capped contribution (pure)
    redis/                  # ioredis client on the single ncn: namespace (the engagement cooldown)
    registry/
      platforms.ts          # the platform registry (canonical valid platforms)
      moderation-actions.ts # the moderation action registry (canonical valid actions)
  types/                    # shared types and the response envelope
drizzle/migrations/         # append-only migrations (0000 foundational, 0001 membership active and left_at, 0002 participant network_xp, 0003 the moderation_actions table)
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
  leveling.test.ts          # the pure curve and contribution functions (unit, no DB)
Dockerfile
docker-compose.yml
docker-compose.dev.yml
```

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
