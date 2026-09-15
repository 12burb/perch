CREATE TABLE "message_edits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"blocks" jsonb NOT NULL,
	"edited_by_type" text NOT NULL,
	"edited_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_edits_type_check" CHECK ("message_edits"."edited_by_type" in ('user', 'bot', 'system'))
);
--> statement-breakpoint
ALTER TABLE "message_edits" ADD CONSTRAINT "message_edits_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_edits_message_idx" ON "message_edits" USING btree ("message_id","created_at" DESC NULLS LAST);