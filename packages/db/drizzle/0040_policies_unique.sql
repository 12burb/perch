-- One policy document per workspace and one per project (ADR-0175). A concurrent first save could
-- insert two rows for the same key, and enforcement then read whichever came back first. Before
-- the unique indexes can exist the duplicates go: the newest save of each key is the one kept.
DELETE FROM "policies" AS "older" USING "policies" AS "newer"
WHERE "older"."workspace_id" = "newer"."workspace_id"
  AND "older"."project_id" IS NOT DISTINCT FROM "newer"."project_id"
  AND ("older"."updated_at", "older"."id") < ("newer"."updated_at", "newer"."id");--> statement-breakpoint
DROP INDEX "policies_workspace_project_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "policies_workspace_idx" ON "policies" USING btree ("workspace_id") WHERE "policies"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "policies_workspace_project_idx" ON "policies" USING btree ("workspace_id","project_id") WHERE "policies"."project_id" is not null;
