CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"session_id" uuid,
	"bot_run_id" uuid,
	"virtual_key_id" uuid,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_actor_check" CHECK ("usage_events"."actor_type" in ('user', 'bot', 'runner', 'external', 'system'))
);
--> statement-breakpoint
CREATE TABLE "virtual_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"name" text DEFAULT '' NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "virtual_keys_subject_check" CHECK ("virtual_keys"."subject_type" in ('user', 'bot', 'runner', 'external'))
);
--> statement-breakpoint
ALTER TABLE "model_profiles" ADD COLUMN "fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_virtual_key_id_virtual_keys_id_fk" FOREIGN KEY ("virtual_key_id") REFERENCES "public"."virtual_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_workspace_idx" ON "usage_events" USING btree ("workspace_id","ts");--> statement-breakpoint
CREATE INDEX "usage_events_key_idx" ON "usage_events" USING btree ("virtual_key_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_keys_hash_idx" ON "virtual_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "virtual_keys_workspace_idx" ON "virtual_keys" USING btree ("workspace_id","created_at");