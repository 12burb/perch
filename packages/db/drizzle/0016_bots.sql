CREATE TABLE "bot_installs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"obo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"trigger_ref" text,
	"status" text DEFAULT 'running' NOT NULL,
	"engine" text,
	"model_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_runs_status_check" CHECK ("bot_runs"."status" in ('running', 'done', 'error', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"handle" "citext" NOT NULL,
	"name" text NOT NULL,
	"level" text DEFAULT 'ui' NOT NULL,
	"spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"orchestrator" boolean DEFAULT false NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bots_level_check" CHECK ("bots"."level" in ('ui', 'spec', 'code', 'external')),
	CONSTRAINT "bots_visibility_check" CHECK ("bots"."visibility" in ('private', 'workspace')),
	CONSTRAINT "bots_status_check" CHECK ("bots"."status" in ('active', 'paused', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "bot_installs" ADD CONSTRAINT "bot_installs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_installs" ADD CONSTRAINT "bot_installs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD CONSTRAINT "bot_memories_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD CONSTRAINT "bot_memories_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_installs_bot_channel_idx" ON "bot_installs" USING btree ("bot_id","channel_id");--> statement-breakpoint
CREATE INDEX "bot_memories_bot_scope_idx" ON "bot_memories" USING btree ("bot_id","scope");--> statement-breakpoint
CREATE INDEX "bot_memories_embedding_idx" ON "bot_memories" USING hnsw ("embedding" vector_cosine_ops) WHERE "bot_memories"."embedding" is not null;--> statement-breakpoint
CREATE INDEX "bot_runs_bot_started_idx" ON "bot_runs" USING btree ("bot_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bot_runs_workspace_started_idx" ON "bot_runs" USING btree ("workspace_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "bots_workspace_handle_idx" ON "bots" USING btree ("workspace_id","handle");