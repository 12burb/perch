CREATE TABLE "race_entrants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"race_id" uuid NOT NULL,
	"session_id" uuid,
	"engine" text NOT NULL,
	"agent" text,
	"branch" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"cost_usd" numeric,
	"files_changed" integer,
	"additions" integer,
	"deletions" integer,
	"checks_exit_code" integer,
	"checks_output" text,
	"detail" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "race_entrants_state_check" CHECK ("race_entrants"."state" in ('running', 'finished', 'failed', 'discarded', 'won'))
);
--> statement-breakpoint
CREATE TABLE "races" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"prompt" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"decided_by" text,
	"decided_by_user_id" uuid,
	"winner_id" uuid,
	"thread_root_id" uuid,
	"card_message_id" uuid,
	"created_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "races_state_check" CHECK ("races"."state" in ('running', 'decided', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD COLUMN "unattended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "race_entrants" ADD CONSTRAINT "race_entrants_race_id_races_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."races"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_entrants" ADD CONSTRAINT "race_entrants_session_id_coding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."coding_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "races" ADD CONSTRAINT "races_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "races" ADD CONSTRAINT "races_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "races" ADD CONSTRAINT "races_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "race_entrants_engine_idx" ON "race_entrants" USING btree ("race_id","engine","branch");--> statement-breakpoint
CREATE INDEX "race_entrants_race_idx" ON "race_entrants" USING btree ("race_id","state");--> statement-breakpoint
CREATE INDEX "race_entrants_session_idx" ON "race_entrants" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "races_project_idx" ON "races" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "races_item_idx" ON "races" USING btree ("work_item_id");--> statement-breakpoint
-- Sessions the board already opened were unattended before there was a column saying so: they
-- settle on `work_item_id` today, and on this from now on (ADR-0133).
UPDATE "coding_sessions" SET "unattended" = true WHERE "work_item_id" IS NOT NULL;
