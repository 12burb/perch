CREATE TABLE "model_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"credential_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_cap" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_for" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_profiles_default_for_check" CHECK ("model_profiles"."default_for" in ('chat', 'code'))
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text DEFAULT 'user' NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text DEFAULT 'api_key' NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"label" text NOT NULL,
	"hint" text,
	"base_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credentials_scope_check" CHECK ("provider_credentials"."scope" in ('user', 'workspace')),
	CONSTRAINT "provider_credentials_kind_check" CHECK ("provider_credentials"."kind" in ('api_key', 'endpoint', 'oauth_ref')),
	CONSTRAINT "provider_credentials_status_check" CHECK ("provider_credentials"."status" in ('active', 'invalid', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD COLUMN "agent" text;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_credential_id_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_profiles_workspace_name_idx" ON "model_profiles" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "model_profiles_default_idx" ON "model_profiles" USING btree ("workspace_id","default_for") WHERE "model_profiles"."default_for" is not null;--> statement-breakpoint
CREATE INDEX "provider_credentials_workspace_idx" ON "provider_credentials" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE INDEX "provider_credentials_owner_idx" ON "provider_credentials" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;