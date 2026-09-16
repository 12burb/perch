CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"limit_usd" numeric(12, 6) NOT NULL,
	"period" text DEFAULT 'month' NOT NULL,
	"warn_at" numeric(4, 3) DEFAULT '0.8' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_subject_check" CHECK ("budgets"."subject_type" in ('workspace', 'user', 'bot')),
	CONSTRAINT "budgets_period_check" CHECK ("budgets"."period" in ('day', 'month', 'total'))
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_subject_idx" ON "budgets" USING btree ("workspace_id","subject_type","subject_id");