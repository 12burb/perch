CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"owner_id" uuid,
	"name" text NOT NULL,
	"layout" text DEFAULT 'board' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_layout_check" CHECK ("saved_views"."layout" in ('board', 'list', 'calendar', 'timeline', 'spreadsheet'))
);
--> statement-breakpoint
CREATE TABLE "work_item_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"work_item_id" uuid NOT NULL,
	"related_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_relations_kind_check" CHECK ("work_item_relations"."kind" in ('blocks', 'blocked_by', 'relates', 'duplicates'))
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_relations" ADD CONSTRAINT "work_item_relations_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_relations" ADD CONSTRAINT "work_item_relations_related_id_work_items_id_fk" FOREIGN KEY ("related_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_views_project_idx" ON "saved_views" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "saved_views_workspace_idx" ON "saved_views" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_relations_idx" ON "work_item_relations" USING btree ("work_item_id","related_id","kind");--> statement-breakpoint
CREATE INDEX "work_item_relations_related_idx" ON "work_item_relations" USING btree ("related_id");--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_status_check" CHECK ("cycles"."status" in ('planned', 'active', 'closed'));