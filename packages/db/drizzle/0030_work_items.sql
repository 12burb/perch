CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"type" text DEFAULT 'task' NOT NULL,
	"title" text NOT NULL,
	"description" jsonb DEFAULT '{"text":""}'::jsonb NOT NULL,
	"state" text DEFAULT 'backlog' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assignee_type" text,
	"assignee_id" uuid,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cycle_id" uuid,
	"module_id" uuid,
	"estimate" numeric,
	"due_at" timestamp with time zone,
	"parent_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"intake_status" text,
	"thread_root_id" uuid,
	"session_id" uuid,
	"pr_url" text,
	"preview_share_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_type_check" CHECK ("work_items"."type" in ('task', 'bug', 'feature', 'epic')),
	CONSTRAINT "work_items_state_check" CHECK ("work_items"."state" in ('backlog', 'queued', 'running', 'needs_you', 'in_review', 'done', 'cancelled')),
	CONSTRAINT "work_items_assignee_check" CHECK (("work_items"."assignee_type" is null and "work_items"."assignee_id" is null)
          or ("work_items"."assignee_type" in ('user', 'bot') and "work_items"."assignee_id" is not null)),
	CONSTRAINT "work_items_priority_check" CHECK ("work_items"."priority" between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_parent_id_work_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_session_id_coding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."coding_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cycles_project_idx" ON "cycles" USING btree ("project_id","starts_at");--> statement-breakpoint
CREATE INDEX "modules_project_idx" ON "modules" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_number_idx" ON "work_items" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "work_items_board_idx" ON "work_items" USING btree ("project_id","state","priority");--> statement-breakpoint
CREATE INDEX "work_items_assignee_idx" ON "work_items" USING btree ("workspace_id","assignee_type","assignee_id");--> statement-breakpoint
CREATE INDEX "work_items_session_idx" ON "work_items" USING btree ("session_id");