CREATE TABLE "bot_chains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"root_message_id" uuid,
	"thread_root_id" uuid NOT NULL,
	"hop" integer DEFAULT 1 NOT NULL,
	"from_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_bot_id" uuid NOT NULL,
	"mode" text DEFAULT 'consult' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"breaker_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_chains_mode_check" CHECK ("bot_chains"."mode" in ('consult', 'handoff', 'fanout')),
	CONSTRAINT "bot_chains_status_check" CHECK ("bot_chains"."status" in ('running', 'done', 'error', 'refused')),
	CONSTRAINT "bot_chains_from_type_check" CHECK ("bot_chains"."from_type" in ('user', 'bot', 'system'))
);
--> statement-breakpoint
ALTER TABLE "bot_chains" ADD CONSTRAINT "bot_chains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_chains" ADD CONSTRAINT "bot_chains_root_message_id_messages_id_fk" FOREIGN KEY ("root_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_chains" ADD CONSTRAINT "bot_chains_thread_root_id_messages_id_fk" FOREIGN KEY ("thread_root_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_chains" ADD CONSTRAINT "bot_chains_to_bot_id_bots_id_fk" FOREIGN KEY ("to_bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_chains_thread_idx" ON "bot_chains" USING btree ("thread_root_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_chains_workspace_idx" ON "bot_chains" USING btree ("workspace_id","created_at" DESC NULLS LAST);