CREATE TABLE "bot_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_root_id" uuid,
	"connection_id" uuid NOT NULL,
	"requested_by" uuid,
	"tool" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_tool_calls_status_check" CHECK ("bot_tool_calls"."status" in ('pending', 'denied', 'done', 'error'))
);
--> statement-breakpoint
ALTER TABLE "connection_grants" ADD COLUMN "requires_permission" jsonb;--> statement-breakpoint
ALTER TABLE "bot_tool_calls" ADD CONSTRAINT "bot_tool_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tool_calls" ADD CONSTRAINT "bot_tool_calls_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tool_calls" ADD CONSTRAINT "bot_tool_calls_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tool_calls" ADD CONSTRAINT "bot_tool_calls_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tool_calls" ADD CONSTRAINT "bot_tool_calls_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_tool_calls_bot_idx" ON "bot_tool_calls" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_tool_calls_status_idx" ON "bot_tool_calls" USING btree ("status");