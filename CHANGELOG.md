# Changelog

All notable changes to noCluNetwork are recorded here, in Keep a Changelog format, grouped under Added, Changed, Fixed, and Removed. The project uses calendar-semver `YYYY.MAJOR.MINOR.PATCH`, applied as a git tag when a meaningful unit ships. Unreleased work accumulates under the [Unreleased] heading until it is tagged.

## [Unreleased]

### Added

- Data-model foundation: the five core tables (participants, platform_accounts, communities, community_platforms, community_members) as Drizzle schema, one file per table with co-located inferred types. participants is the spine, with a nullable-unique noclulabs_identity_id (null means a ghost) and no foreign key onto noclulabs.com.
- The first Drizzle migration, hand-edited per the migration convention to prepend the citext and pgcrypto extensions and the set_updated_at trigger function, then the tables, then a per-table set_updated_at trigger. Ids default to the native Postgres 18 uuidv7().
- The platform registry (`src/lib/registry/platforms.ts`): the app-layer canonical source of valid platforms (discord for now), a const array, the derived type, and a Zod schema, with no Postgres enum. The route platform enum is projected from it, so the OpenAPI spec cannot drift.
- The service-token resolve-or-create routes under `/api/v1`: `POST /api/v1/participants/resolve` (resolve or create a participant from a platform user id) and `POST /api/v1/communities/resolve` (resolve or create a community from a platform group id). Both are idempotent and race-safe (a lost unique-key race rolls back and re-resolves), thin wrappers over the resolve services, and represented in the OpenAPI spec with request and response schemas.
- The production DATABASE_URL guard: when NODE_ENV is production, config validation fails fast unless DATABASE_URL carries the `uselibpqcompat=true` suffix.
- The DB-backed integration test harness: a global setup that ensures the test database exists and applies the migrations once (so the migration is exercised), with per-test truncation for isolation. Tests cover the migration (extensions, tables, the set_updated_at trigger), both resolve routes (idempotency, unique constraints, the unknown-platform 400, the missing-token 401), and the production config guard.
- Repository bootstrap: the noCluNetwork repo under the noclulabs org, with the four bible files (CLAUDE.md, README.md, ROADMAP.md, CHANGELOG.md).
- Fastify Core API skeleton: the app factory and startup, a `GET /health` route, and the response envelope (`{ success, data?, error?, pagination? }`) with a typed error class, a Fastify error handler, and a BigInt-to-Number serialization hook.
- Zod-validated environment config (`src/config.ts`) covering the database URL, the Redis URL, the service token, and the noclulabs.com channel credential.
- Drizzle wiring: the connection module, an empty migrations setup, and the package scripts (`db:generate`, `db:migrate`, `db:studio`), following the registry-as-canonical and append-only-migrations conventions and the production SSL suffix gotcha.
- Redis client on a single `ncn:` namespace.
- The service-auth plugin (`X-Service-Token` plus `X-Service-Name`) for bot-facing routes.
- The OpenAPI spec via `@fastify/swagger` (the contract noCluBot's typed client is generated from).
- The CI gate (GitHub Actions): lint, type-check, test, and build, with Postgres and Redis services.
- Docker: a multi-stage `Dockerfile` (non-root runtime on Node 22), `docker-compose.dev.yml` (local Postgres 18 and Redis 7), and `docker-compose.yml` (the production API on host port 3000).
- Vitest tests covering `GET /health` and the service-auth plugin (missing, wrong, and correct token).

### Changed

- The global rate limiter now exempts the liveness probe (`GET /health`) and the trusted service-token resolve routes per route (`config.rateLimit` false), so probes and bots are never throttled. The limiter stays registered for any future public-facing tier.

### Fixed

- The BigInt-to-Number preSerialization hook recursed into every object, which flattened Date values (for example a row's created_at) to `{}` and broke date-time serialization. It now recurses into plain objects and arrays only, leaving Date and other class instances intact. The bug was latent in the bootstrap (the health route returns no dates) and surfaced with the first timestamp-returning routes.

[Unreleased]: https://github.com/noclulabs/noclunetwork/commits/main
