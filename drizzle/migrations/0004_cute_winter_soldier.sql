-- The verify-sync watermark table (phase 5). A plain append-only CREATE TABLE.
-- Hand-edited after drizzle-kit generate to append the set_updated_at BEFORE
-- UPDATE trigger, reusing the trigger function defined in migration 0000 (drizzle
-- does not emit trigger statements). 0000 through 0003 are untouched.
CREATE TABLE "sync_watermarks" (
	"stream" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"full_rescan_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
create trigger sync_watermarks_set_updated_at
  before update on sync_watermarks
  for each row execute function set_updated_at();
