# Roadmap

Forward-looking plan for noCluNetwork. Completed work is recorded in CHANGELOG.md, not narrated here. Items leave this file when they ship. The rebuild follows the noClu architect-executor workflow: one phase and one PR at a time, with only the next phase fleshed out in detail and the phase after it planned once the current one ships.

## Status snapshot

- Bootstrapped scaffold (the repo skeleton, the four bibles, the Fastify Core API with a health route, Drizzle and migrations wiring, Zod config, the Redis client on the `ncn:` namespace, the service-auth plugin, OpenAPI, and CI).
- Data-model foundation shipped (phase 2): the five core tables and the first migration, the platform registry, and the service-token resolve-or-create routes under `/api/v1`, with a DB-backed test harness. See CHANGELOG.md.
- Verification-driven claim-and-merge shipped (phase 3): the `POST /api/v1/participants/claim` endpoint, the transactional five-case claim-and-merge (the survivor is always the identity-bearer), the USER_HAS_DATA guard over a centralized participant-owned-relations list, and the concurrency handling. No bridge yet; the claim is driven by synthetic assertions in tests until phase 5. See CHANGELOG.md.
- Community membership lifecycle shipped (phase 4a): the `POST /api/v1/memberships/ensure` and `POST /api/v1/memberships/leave` routes under `/api/v1`, soft leave with rejoin (the `active` and `left_at` columns and the 0001 migration), community_members joining the participant-owned-relations list with the re-point-or-combine merge relocation, and the catalog assertion that fails loud if a participant_id foreign-key table is ever left off that list. This closes the phase 3 community_members deferral. No XP, leveling, or moderation yet. See CHANGELOG.md.
- This is the fresh rebuild of the legacy portalNetwork Core API and bot suite, built from the portalNetwork assessment spec, not ported. The legacy OAuth2 provider, native auth, gambling games, native web chat, the half-built cross-platform bridge, and the five stub adapters are out of scope by decision (see Out of scope below).

## The rebuild arc

Phases 1 (bootstrap), 2 (data-model foundation), 3 (verification-driven claim-and-merge), and 4a (community membership lifecycle) have shipped; see the status snapshot and CHANGELOG.md. Ordering past phase 4 is provisional and is firmed one phase at a time. Phase numbering starts fresh for the rebuild and is kept stable, so shipped phases leave the arc but their numbers are not reused. Phase 4 (the community engagement core) is split into slices: 4a (membership lifecycle) shipped, and 4b and 4c remain below.

4b. Engagement and leveling. Per-community XP, the network-level progression curve, message-activity ingestion and antispam, and the level-up events. This is the engine that produces signals. 4b adds the XP and leveling tables; each is participant-owned, so each MUST join the centralized participant-owned-relations list (`src/services/participants/owned-relations.ts`) when it lands, or the catalog assertion fails loud (the merge would otherwise drop a survivor's rows). 4b must also extend the community_members merge combine rule to combine XP when two memberships merge into one (today the combine handles permission_level, active, and left_at; XP would sum or take the max as decided then).

4c. Moderation and cases. Warnings, mutes, bans, mod actions, and permission_level enforcement (4a defaults permission_level to 0 and does not interpret it). The remaining engagement-core slice, ordered provisionally after 4b.

5. The bidirectional bridge to noCluID (cross-repo with noclulabs.com). The signal emitter (the append-only intake contract, the ledger's first real writer) and the scoped read contract (noCluID data for surfacing). This phase wires the real verification source: noclulabs.com drives the phase 3 claim endpoint when a person verifies a platform on noCluID (today the claim is driven only by synthetic assertions in tests). On the noclulabs.com side this phase lands the intake receiver and the scoped read API as their own PRs.

6. noCluBot and the summon-your-noCluID surface. Bootstrap the noCluBot monorepo, the Discord adapter (resolve, service-token call, render), and the OpenAPI-generated client. Then the surfacing commands: a user runs a bot command and the bot returns their noCluID data, with the dual-score privacy split (public score shareable in a channel, true score private and only for the authenticated subject).

## North stars (committed, built at their phase)

- The summon-your-noCluID surface. A user carries their noCluID across communities: verify a platform once, and that platform's bot becomes a window onto their identity, in both directions (signals up, data down). The read direction enforces the dual-score and visibility model at the source (true score owner-only and private, public score shareable). This is the feature that brings the system together; phase 6 is its first cut.
- Discord as a noCluID provider. A required noclulabs.com-side addition (a registry entry in noCluID's OAuth provider registry) that establishes the discord-id to noclulabs-identity link. It is the linchpin for both the intake attribution and the surfacing read. Sequenced alongside the bridge phase.

## Deferred and undecided

- $IOC currency. Keep it only if a network engagement currency is still wanted. If kept, keep the append-only ledger pattern, not the legacy per-community coins or games. Its authenticity contribution defers to noCluID regardless. Decide when the economy phase is reached.
- A noCluNetwork web portal. If a browser surface is ever wanted, it federates auth like noCluCal (a new subdomain added to noclulabs.com's TRUSTED_SUITE_HOSTNAMES, sharing AUTH_SECRET, reading the parent-domain cookie). Not in the current arc.
- Additional platforms (Telegram, Slack, and so on). Added as bots inside noCluBot when there is a real need, never as the legacy stubs.

## Out of scope (dropped from the rebuild)

- The OAuth2 provider ("continue with portalNetwork"). noclulabs.com is the issuer.
- Native auth, password storage, and JWT issuance. Federate from noclulabs.com.
- Any standalone authenticity computation. Emit signals to noCluID and read a score back.
- The gambling-games economy.
- Native web chat (Crossroads, the WebSocket and pub/sub stack), unless chat becomes a stated product requirement.
- The half-built cross-platform message bridge.
- The five secondary adapter stubs.

## Cross-repo note

The bridge phases touch two repos. The signal emitter and the read-contract consumer land in noCluNetwork; the intake receiver, the scoped read API, and the Discord noCluID provider land in noclulabs.com. Those noclulabs.com changes ship as their own PRs in that repo, governed by its IDENTITY-PLAYBOOK.md and AUTH-PLAYBOOK.md.
