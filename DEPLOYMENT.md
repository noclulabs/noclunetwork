# Deployment

> Production deployment runbook for noCluNetwork. Read this before deploying, redeploying, or changing the live bridge configuration.

This document records how noCluNetwork is deployed to production and how the phase 5 bridge was brought live. That knowledge existed only operationally (the bring-up happened on the live droplet, and there was no code change or pull request for it), so this file is the authoritative account for anyone deploying or redeploying the service later. It is a companion to the four bible files (CLAUDE.md, README.md, ROADMAP.md, CHANGELOG.md), not a replacement for them: the bibles own project state and conventions, and this file owns the operational procedure.

Nothing in this document is a secret. Passwords, hosts, tokens, the droplet address, and end-user identifiers are described generically and never reproduced. Non-secret internal names that a deployer genuinely needs (the container name in the base URL, the managed-cluster name, and the database and role names) are included.

## Overview

noCluNetwork is the noClu estate's cross-platform community-engagement engine: a Fastify Core API that runs communities, membership, leveling, and moderation, resolves platform accounts to noClu identities, and acts as the bidirectional bridge between chat platforms and noCluID. It is a relying party of noclulabs.com, never an auth or identity issuer. See CLAUDE.md and README.md for the full role in the suite.

In production it runs in Docker on the shared noClu DigitalOcean droplet, co-located with noclulabs.com, and reaches noclulabs.com over a private Docker network. As of this writing the bridge is deployed and verified live in both directions, with the inbound read-down endpoint (summon) still disabled by design until noCluBot exists to consume it.

## Topology

noCluNetwork runs on the same DigitalOcean droplet as noclulabs.com, inside the noCluHub VPC. Its project directory on the droplet is `/opt/noclunetwork`, matching the `/opt` convention the other suite services on the droplet follow.

It runs via Docker Compose with two services:

- `api`: the `noclunetwork:latest` image, built from the repository Dockerfile (a multi-stage build that runs as a non-root user on Node 22).
- `redis`: a dedicated `redis:7` instance with a named data volume, which the `api` service reaches at `redis:6379`.

The `api` service publishes no host port. Nothing public reaches noCluNetwork yet: every bridge call it makes is outbound, and the only inbound endpoint (the summon) stays disabled until noCluBot exists. Host ports on the droplet were also already occupied, so publishing one was both unnecessary and avoided. Public exposure behind Caddy on host port 3000, as described in README.md and CLAUDE.md, is the intended shape for when a public surface is needed; it is not the current deployed shape.

The `api` service is attached to two Docker networks:

- Its own default Compose network, where it reaches its `redis` at `redis:6379`.
- The external network `noclulabscom_default`, which is noclulabs.com's Compose network. Joining it is what lets noCluNetwork reach the noclulabs.com container directly, container to container, without going out to the public internet.

`NOCLULABS_BASE_URL` is set to `http://noclulabscom-web-1:3000`: the noclulabs.com web container's name, on its container port, over the shared Docker network. Plain HTTP is correct here. TLS is terminated publicly by Caddy, the bridge traffic never leaves the private Docker network, and it is the bearer token, not the transport, that gates the bridge endpoints.

### The shared-token name mapping

The bridge is authenticated by one shared secret that has a different variable name on each side. On the noCluNetwork side it is `NOCLULABS_SERVICE_TOKEN`. On the noclulabs.com side the same value is `NETWORK_SERVICE_TOKEN`. This one value, two names arrangement is the single most common source of bridge auth confusion, so confirm both sides carry the same value under their respective names before debugging anything else.

### A note on the committed compose file

The deployed shape above (no published host port, a dedicated `redis` service, and the `noclulabscom_default` external network) was applied operationally and is not what the committed `docker-compose.yml` in the repository currently expresses. The committed `docker-compose.yml` publishes host port `3000:3000`, defines no `redis` service, and references no external network; it reflects the earlier single-service, Caddy-fronted intent. Treat the topology described in this document as the production reality and do not assume the committed compose file is the production compose. Reconciling the committed compose with the deployed shape is a known follow-up (see below).

## Database

noCluNetwork uses its own `noclunetwork` database on the existing `noclulabs-postgres-prod` managed cluster (DigitalOcean Managed Postgres, PostgreSQL 18), with a dedicated `noclunetwork` database user. This is not a separate cluster: it is an isolated database on the same managed cluster noclulabs.com already uses, so the two products share infrastructure while keeping their data separate.

The connection uses the cluster's private VPC host, not its public host, so database traffic stays inside the VPC alongside the droplet.

The `DATABASE_URL` carries the suffix `?sslmode=require&uselibpqcompat=true`. The `uselibpqcompat=true` part is required by node-postgres: without it the driver attempts `sslmode=verify-full` and fails against the managed cluster's certificate with `SELF_SIGNED_CERT_IN_CHAIN`. This is the same gotcha documented in CLAUDE.md and `.env.example`, and it also governs drizzle-kit and drizzle-orm, which use the same driver.

There is an asymmetry to remember: the raw `psql` client does not accept the `uselibpqcompat` parameter and rejects a URL that carries it. So node-postgres needs the suffix and `psql` must not have it. Any psql-based check on production must strip the suffix from the URL first. (`.env.example` notes that `psql` does not need the suffix; in practice `psql` will actively reject it, so stripping it is required, not merely optional.)

## Database privilege prerequisites

DigitalOcean Managed Postgres restricts a regular database user, so on a fresh deploy the `noclunetwork` user cannot run the migrations until three grants are made by the cluster admin user (`doadmin`), connected to the `noclunetwork` database. Make all three before running migrations.

1. Create the two extensions as `doadmin`, because a regular user lacks the privilege to `CREATE EXTENSION`:

   ```sql
   CREATE EXTENSION IF NOT EXISTS citext;
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   ```

   The first migration (`drizzle/migrations/0000_kind_nicolaos.sql`) opens with a comment block, and its first SQL statements are `create extension if not exists citext;` and `create extension if not exists pgcrypto;`. Once `doadmin` has created them, those two lines in the migration become no-ops, so the migration run does not need extension-creation privilege.

2. Grant create-in-public to the `noclunetwork` user:

   ```sql
   GRANT USAGE, CREATE ON SCHEMA public TO noclunetwork;
   ```

   PostgreSQL 15 and later no longer grant create-in-public to all users by default. Without this grant the migration fails at its first object creation with "permission denied for schema public."

3. Grant database-level create to the `noclunetwork` user:

   ```sql
   GRANT CREATE ON DATABASE noclunetwork TO noclunetwork;
   ```

   drizzle-kit records applied migrations in its own `drizzle` schema, and creating that schema requires the database-level create privilege. Without this grant, drizzle-kit's migrate fails.

### Diagnostic note: drizzle-kit swallows the underlying error

When a privilege is missing, drizzle-kit's `migrate` does not surface the underlying Postgres error. The command stops at `applying migrations...` and exits with no message: no error text, and sometimes not even a nonzero-exit banner. This is deeply misleading, because it looks like a hang or a silent success rather than a permission failure.

When that happens, apply the failing migration's SQL directly through `psql` with `-v ON_ERROR_STOP=1` to surface the real Postgres error, fix the privilege it names, then re-run the migration. This is the difference between a five-minute fix and an hour of confusion, so reach for it as soon as `migrate` stops at `applying migrations...` with no output.

## Migrations

On a fresh deploy, complete the three database privilege grants in the section above before running any migration, or the run will fail, and fail silently (see the diagnostic note there).

The runtime image does not contain drizzle-kit. The Dockerfile's build stage runs `pnpm prune --prod` as its final step (line 20 of the Dockerfile), which removes dev dependencies, and drizzle-kit is a dev dependency. So migrations cannot run from the runtime image, and they cannot run from the build stage either, because the prune is the last thing the build stage does before the runtime stage copies the pruned `node_modules`.

The approach used for the first deploy runs migrations from a one-off container that still has the dev dependencies:

1. Start a `node:22-bookworm-slim` container that mounts the repository.
2. Inside it, run `pnpm install --frozen-lockfile` to get the full dependency set (including drizzle-kit).
3. Run the migration. The repository script is `db:migrate:deploy`, which is `drizzle-kit migrate`.

Run the container attached to the `noclulabscom_default` network so it can reach the database over the VPC, and supply its environment with `--env-file .env` rather than inline variables (see the operational gotchas about `DATABASE_URL`).

### Known gap

This mounted ad hoc install is a stopgap, not a hardened mechanism. It should be replaced by a dedicated migration image or build stage that retains drizzle-kit, or by a migration entrypoint, so that migrations do not depend on mounting the repository and running an install by hand on the droplet. This is tracked in the follow-ups below.

## Configuration

The authoritative list of environment variables and their meanings is `.env.example`. The production values are supplied to the `api` service through the Compose environment and an `.env` file on the droplet; never commit real values. Two configuration facts matter most for a correct and secure deploy.

### The credential split

Two service credentials exist, in two directions, and must not be conflated:

- `SERVICE_TOKEN` is the inbound credential. A bot (noCluBot, in future) presents it to noCluNetwork as the `X-Service-Token` header together with `X-Service-Name`. It gates the bot-facing routes.
- `NOCLULABS_SERVICE_TOKEN` is the outbound credential. noCluNetwork presents it to noclulabs.com as a bearer token for the intake, read, and verify contracts. This is the value that maps to `NETWORK_SERVICE_TOKEN` on the noclulabs.com side.

They are different secrets, in different directions, and mixing them up breaks the bridge in ways that are easy to misdiagnose.

### The four bridge flags

Each bridge capability is gated by its own flag, each ships off by default, and each gates exactly one capability:

- `VERIFY_SYNC_ENABLED`: the inbound verify poller (reads verified connections from noclulabs.com surface B and drives the participant claim).
- `EMIT_SYNC_ENABLED`: the outbound emit on a network level change (pushes the capped leveling contribution to noclulabs.com surface A).
- `EMIT_RECONCILE_ENABLED`: the scheduled emit backstop (a stateless full pass that re-emits every claimed participant, so any emit the on-event path missed eventually lands). Its scheduler starts only when `EMIT_SYNC_ENABLED` is also true.
- `SUMMON_ENABLED`: the inbound read-down endpoint (`POST /api/v1/summon`, which reads a subject's noCluID score from noclulabs.com surface C).

Config load fails fast if any of these flags is enabled without both `NOCLULABS_BASE_URL` and `NOCLULABS_SERVICE_TOKEN` set. This is deliberate: a half-configured bridge should never start. See `.env.example` and README.md for each flag's cadence and tuning variables (`VERIFY_SYNC_INTERVAL_MS`, `EMIT_RECONCILE_INTERVAL_MS`, and the rest).

## Go-live runbook

The bridge was brought up as a staged sequence, and the order is deliberate: each stage is proven before the next flag is flipped. Follow the same sequence for a fresh bring-up. Keep each flag flip together with the proof that it worked.

### Stage 0: wiring, before any flag

Prove the shared token and the private path before enabling any capability. From inside the running `api` container, call noclulabs.com surface B directly and confirm all three of:

- 200 with the correct `NOCLULABS_SERVICE_TOKEN` bearer.
- 401 with no token.
- 401 with a wrong token.

The lean runtime image has no curl, so make the call with `node -e` using the built-in `fetch` (see the operational gotchas). Passing this stage proves that the container can reach noclulabs.com over the private network and that the shared token is correct on both sides.

### Stage 1: verify

Enable `VERIFY_SYNC_ENABLED`, restart, and confirm:

- The poller reads the verified connections from surface B and drives the claim.
- A participant is linked to its noclulabs identity, with a verified platform account.
- The durable watermark (in the `sync_watermarks` table) advances to the connection's cursor.

Then confirm idempotency: a subsequent cycle reports the connection already linked and does nothing further. The claim is idempotent, so re-processing the same connection is safe.

### Stage 2: emit and reconcile

Enable `EMIT_SYNC_ENABLED` and `EMIT_RECONCILE_ENABLED`, restart, then cause a real network level change for the claimed participant by calling the engagement endpoint (which also creates the community and the membership as a side effect of the first engagement). Confirm both:

- The emit lands the first real `network.level` row in noclulabs.com's `identity_signals` ledger, with source `noclu-network` (noclulabs.com sets the source itself).
- The subject's score, read back through surface C, shows the network bucket contribution at level times 0.1 in both the public score and the true score. (Level times 0.1 is how the noclulabs.com scorer weights the `network.level` signal into its score bucket; it is a noclulabs.com-side scoring detail, distinct from the emitted signal value of `min(level, 50) / 50`.)

This is the end-to-end proof that the noclulabs.com scorer reads the ledger noCluNetwork writes. It also confirms three product decisions are live: the additive-extended maximum, the public exposure of leveling, and the read-down acting-for-subject path.

### Stage 3: summon

Deferred by design. `SUMMON_ENABLED` stays off until noCluBot exists to consume the read-down. Surface C itself is confirmed responding (it is exercised by the Stage 2 score read-back), so enabling summon later is a flag flip plus a consumer, not new integration work.

## Operational gotchas

Two hazards cost real time on the first bring-up. Both are worth internalizing before touching production.

### No curl in the lean image

The lean runtime image contains no curl. For any in-container HTTP check (Stage 0, and any later probe), use `node -e` with the built-in `fetch` instead. The runtime is Node 22, so `fetch` is available globally.

### Never interpolate DATABASE_URL onto a shell command line

`DATABASE_URL` contains `&uselibpqcompat=true`. If the value is interpolated directly onto a shell command line, the unescaped `&` is parsed by the shell as a background operator. That both backgrounds the command and echoes the expanded value, which leaks the password into the terminal and any shell history or logs.

The safe pattern is to never put the value on a command line at all: pass it through `--env-file` and let the container read it from its own environment, or, for a `psql` check that needs the value, strip the `uselibpqcompat` suffix inside the container where the value is already in the environment, rather than expanding it on an outer command line. Treat the full `DATABASE_URL` as a secret string that only ever moves through files and environment variables, never through argument interpolation.

## Current live state

This is a point-in-time snapshot as of 2026-06-30. Verify against the running configuration before relying on it.

- The phase 5 bridge is deployed and verified live in both directions.
- Production flag states: `VERIFY_SYNC_ENABLED` on, `EMIT_SYNC_ENABLED` on, `EMIT_RECONCILE_ENABLED` on, `SUMMON_ENABLED` off.
- Stage 0, Stage 1, and Stage 2 are verified live. Stage 3 (summon) is deferred pending noCluBot.

Test data exists in production from the Stage 2 verification: a test community, and the engagement and ledger activity that proving the emit produced. A future reader should know that the earliest production rows are verification artifacts, not organic community activity, and should not mistake them for real usage.

## Known follow-ups

Recorded here so they are not lost. None of these blocks the current live operation.

- The repository is untagged and `package.json` is at `0.0.0`. A calendar-semver tagging pass for the merged work is pending, and is separate from this document.
- The migration mechanics should be hardened: a dedicated migration image or build stage that retains drizzle-kit, or a migration entrypoint, instead of the mounted ad hoc install described above.
- The database privilege grants should be codified into a deploy script, so a future environment does not require the three `doadmin` grants to be run by hand.
- The negative-test guards are pending a full run to close verification: a bad inbound token, an unknown subject, a malformed acting-for-subject value, and the privacy default that omits the true score for a non-owner. Running these confirms the failure and privacy paths, not just the happy path.
- The committed `docker-compose.yml` should be reconciled with the deployed shape (no published host port, a dedicated `redis` service, and the `noclulabscom_default` external network), so that the repository's compose file matches production rather than the earlier single-service intent.
