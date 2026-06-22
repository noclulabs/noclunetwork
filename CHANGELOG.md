# Changelog

All notable changes to noCluNetwork are recorded here, in Keep a Changelog format, grouped under Added, Changed, Fixed, and Removed. The project uses calendar-semver `YYYY.MAJOR.MINOR.PATCH`, applied as a git tag when a meaningful unit ships. Unreleased work accumulates under the [Unreleased] heading until it is tagged.

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/noclulabs/noclunetwork/commits/main
