ALTER TABLE "mcp_servers" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "command" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_servers_project_idx" ON "mcp_servers" USING btree ("project_id");