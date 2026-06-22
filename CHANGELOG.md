# Changelog

All notable changes to noCluNetwork are recorded here, in Keep a Changelog format, grouped under Added, Changed, Fixed, and Removed. The project uses calendar-semver `YYYY.MAJOR.MINOR.PATCH`, applied as a git tag when a meaningful unit ships. Unreleased work accumulates under the [Unreleased] heading until it is tagged.

## [Unreleased]

### Added

- Verification-driven claim-and-merge: `POST /api/v1/participants/claim` (service-token gated), accepting a verification assertion (platform, platformUserId, noclulabsIdentityId) and attaching a platform account to its noclulabs identity. This is the mechanism that unifies cross-platform ghosts into one identity-linked participant. Represented in the OpenAPI spec with the registry-derived platform enum, under the serviceToken security scheme.
- The claim-and-merge logic (`src/services/participants/claim.ts`), one transaction with five cases: resolve-or-create the account if unseen (reusing the phase 2 path); already linked (idempotent, ensure verified); linked to a different identity (409, change nothing); claim a ghost in place (set the identity, verify the account); and merge a ghost into the participant that already holds the identity (relocate the ghost's owned rows, verify the claimed account, delete the ghost). The survivor of a merge is always the identity-bearer; the response reports the outcome (claimed, already_linked, or merged) and the removed ghost id on a merge.
- The USER_HAS_DATA guard and a single centralized list of participant-owned relations (`src/services/participants/owned-relations.ts`). The relocation step and the guard iterate the same list, so they cannot drift: the guard aborts the merge (rolling back) if the loser still owns any row after relocation. In this phase the only owned relation is platform_accounts; phase 4 extends the list for community memberships and XP.
- Concurrency handling for claim-and-merge: each claim locks the platform account row (the stable anchor that survives every case) and the touched participant rows in id order with SELECT ... FOR UPDATE, and retries on a lost claim-in-place race (the noclulabs_identity_id unique violation). Two simultaneous claims of the same account and identity converge on one survivor with no duplicate participant.
- Claim-and-merge integration tests (`test/db/claim-and-merge.test.ts`): all five cases, the USER_HAS_DATA relocation of a multi-account ghost, the concurrency race, and route validation (uuidv7 identity ids, malformed id, unknown platform, missing token).
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

- The dev Postgres host port moved from 5433 to 5439 (docker-compose.dev.yml, the CI Postgres service, the .env.example default, and the test and CI DATABASE_URL values). 5433 collides with the noclulabs.com dev Postgres on the developer machine, so the two could not run side by side. The container port stays 5432.
- The docker-compose.dev.yml Postgres volume now mounts at `/var/lib/postgresql` instead of `/var/lib/postgresql/data`. The postgres:18 image stores data under a major-version subdirectory and rejects the legacy mount path, so local dev Postgres could not start before this change. CI is unaffected (its service Postgres has no volume mount).
- Vitest now runs test files serially (`fileParallelism` false). A second DB-backed test file shares the single test database with the first, and isolation is by truncation between cases, so files must not run concurrently.
- The global rate limiter now exempts the liveness probe (`GET /health`) and the trusted service-token resolve routes per route (`config.rateLimit` false), so probes and bots are never throttled. The limiter stays registered for any future public-facing tier.

### Fixed

- The BigInt-to-Number preSerialization hook recursed into every object, which flattened Date values (for example a row's created_at) to `{}` and broke date-time serialization. It now recurses into plain objects and arrays only, leaving Date and other class instances intact. The bug was latent in the bootstrap (the health route returns no dates) and surfaced with the first timestamp-returning routes.

[Unreleased]: https://github.com/noclulabs/noclunetwork/commits/main
