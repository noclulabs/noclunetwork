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
  index.ts          # runtime entry point (invokes start)
  server.ts         # Fastify app factory and the start routine
  config.ts         # Zod-validated environment config
  plugins/          # Fastify plugins (service auth, error handler, swagger)
  routes/           # thin route handlers, one area per directory
  services/         # domain logic, one area per directory
  lib/
    db/             # Drizzle schema and the connection module
    redis/          # ioredis client on the single ncn: namespace
    registry/       # registry-as-canonical sources (signal types, and so on)
  types/            # shared types and the response envelope
drizzle/migrations/ # append-only migration files
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
