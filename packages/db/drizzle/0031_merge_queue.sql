CREATE TABLE "merge_queue_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"session_id" uuid,
	"branch" text NOT NULL,
	"base" text NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"position" integer NOT NULL,
	"failure" text,
	"detail" text,
	"checks" jsonb,
	"head" text,
	"thread_root_id" uuid,
	"card_message_id" uuid,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_queue_state_check" CHECK ("merge_queue_entries"."state" in ('waiting', 'landing', 'landed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "merge_queue_entries" ADD CONSTRAINT "merge_queue_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_entries" ADD CONSTRAINT "merge_queue_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_entries" ADD CONSTRAINT "merge_queue_entries_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_entries" ADD CONSTRAINT "merge_queue_entries_session_id_coding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."coding_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_position_idx" ON "merge_queue_entries" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "merge_queue_state_idx" ON "merge_queue_entries" USING btree ("project_id","state","position");--> statement-breakpoint
CREATE INDEX "merge_queue_item_idx" ON "merge_queue_entries" USING btree ("work_item_id");