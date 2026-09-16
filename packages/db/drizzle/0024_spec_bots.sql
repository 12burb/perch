ALTER TABLE "bots" ADD COLUMN "source_project_id" uuid;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "source_path" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "source_error" text;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_source_project_id_projects_id_fk" FOREIGN KEY ("source_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bots_source_project_idx" ON "bots" USING btree ("source_project_id");