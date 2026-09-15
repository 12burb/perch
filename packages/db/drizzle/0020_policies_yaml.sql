ALTER TABLE "policies" ADD COLUMN "yaml" text;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "policy_yaml";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "policy_yaml";