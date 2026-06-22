ALTER TABLE "community_members" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "community_members" ADD COLUMN "left_at" timestamp with time zone;