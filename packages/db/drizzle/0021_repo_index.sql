CREATE TABLE "repo_index" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"path" text NOT NULL,
	"chunk_no" integer NOT NULL,
	"kind" text NOT NULL,
	"symbol" text,
	"start_line" integer DEFAULT 1 NOT NULL,
	"end_line" integer DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"text_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(symbol, '') || ' ' || path || ' ' || content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_index_kind_check" CHECK ("repo_index"."kind" in ('symbol', 'chunk', 'doc'))
);
--> statement-breakpoint
ALTER TABLE "model_profiles" DROP CONSTRAINT "model_profiles_default_for_check";--> statement-breakpoint
ALTER TABLE "repo_index" ADD CONSTRAINT "repo_index_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_index_project_path_chunk_idx" ON "repo_index" USING btree ("project_id","path","chunk_no","commit_sha");--> statement-breakpoint
CREATE INDEX "repo_index_project_idx" ON "repo_index" USING btree ("project_id","commit_sha");--> statement-breakpoint
CREATE INDEX "repo_index_text_idx" ON "repo_index" USING gin ("text_search");--> statement-breakpoint
CREATE INDEX "repo_index_embedding_idx" ON "repo_index" USING hnsw ("embedding" vector_cosine_ops) WHERE "repo_index"."embedding" is not null;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_default_for_check" CHECK ("model_profiles"."default_for" in ('chat', 'code', 'embedding'));