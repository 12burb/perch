ALTER TABLE "runners" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "idle_since" timestamp with time zone;