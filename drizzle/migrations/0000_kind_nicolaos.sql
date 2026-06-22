-- Foundational migration for the noCluNetwork data model.
-- Hand-edited after drizzle-kit generate to prepend the citext and pgcrypto
-- extensions and the set_updated_at trigger function (drizzle does not emit
-- CREATE EXTENSION or trigger statements), and to append a per-table
-- set_updated_at trigger. The extensions are the standard baseline for this and
-- later phases. See the migration convention in CLAUDE.md.
create extension if not exists citext;
--> statement-breakpoint
create extension if not exists pgcrypto;
--> statement-breakpoint
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"community_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"permission_level" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_members_community_id_participant_id_key" UNIQUE("community_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "community_platforms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"community_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"platform_group_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_platforms_platform_platform_group_id_key" UNIQUE("platform","platform_group_id")
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"noclulabs_identity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_noclulabs_identity_id_unique" UNIQUE("noclulabs_identity_id")
);
--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"participant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"platform_user_id" text NOT NULL,
	"platform_username" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_accounts_platform_platform_user_id_key" UNIQUE("platform","platform_user_id")
);
--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_platforms" ADD CONSTRAINT "community_platforms_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_members_community_id_idx" ON "community_members" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "community_members_participant_id_idx" ON "community_members" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "community_platforms_community_id_idx" ON "community_platforms" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "platform_accounts_participant_id_idx" ON "platform_accounts" USING btree ("participant_id");--> statement-breakpoint
create trigger communities_set_updated_at
  before update on communities
  for each row execute function set_updated_at();
--> statement-breakpoint
create trigger community_members_set_updated_at
  before update on community_members
  for each row execute function set_updated_at();
--> statement-breakpoint
create trigger community_platforms_set_updated_at
  before update on community_platforms
  for each row execute function set_updated_at();
--> statement-breakpoint
create trigger participants_set_updated_at
  before update on participants
  for each row execute function set_updated_at();
--> statement-breakpoint
create trigger platform_accounts_set_updated_at
  before update on platform_accounts
  for each row execute function set_updated_at();
