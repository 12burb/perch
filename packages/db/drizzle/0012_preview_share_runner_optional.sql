ALTER TABLE "preview_shares" DROP CONSTRAINT "preview_shares_runner_id_runners_id_fk";
--> statement-breakpoint
ALTER TABLE "preview_shares" ALTER COLUMN "runner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;