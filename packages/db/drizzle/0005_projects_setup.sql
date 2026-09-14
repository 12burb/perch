CREATE TABLE "deploy_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"private_key_ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_keys_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source" text DEFAULT 'empty' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status_message" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "head" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "config_error" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "devcontainer" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "deploy_keys" ADD CONSTRAINT "deploy_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_check" CHECK ("projects"."source" in ('empty', 'upload', 'clone'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_check" CHECK ("projects"."status" in ('pending', 'setting_up', 'ready', 'error'));