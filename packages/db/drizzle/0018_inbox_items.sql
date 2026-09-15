CREATE TABLE "inbox_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snoozed_until" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_items_kind_check" CHECK ("inbox_items"."kind" in ('permission', 'preflight', 'pr', 'budget', 'bot_failure', 'chain', 'intake', 'mention')),
	CONSTRAINT "inbox_items_status_check" CHECK ("inbox_items"."status" in ('open', 'snoozed', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_items_user_status_idx" ON "inbox_items" USING btree ("user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_items_ref_idx" ON "inbox_items" USING btree ("user_id","kind","ref_type","ref_id");