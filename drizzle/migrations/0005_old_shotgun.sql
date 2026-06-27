-- The stale-link marker for the bridge emit capability (phase 5). A plain
-- append-only ALTER that adds one nullable column with a null default, so it is a
-- safe additive migration with no backfill. 0000 through 0004 are untouched, and
-- the existing set_updated_at trigger on participants already maintains updated_at.
-- A null identity_emit_disabled_at means emit normally; a timestamp means a prior
-- emit returned unknown_subject and the subject is a confirmed stale link.
ALTER TABLE "participants" ADD COLUMN "identity_emit_disabled_at" timestamp with time zone;
