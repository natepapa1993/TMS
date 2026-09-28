CREATE TABLE "mail_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"message_id" text NOT NULL,
	"source" text DEFAULT 'http' NOT NULL,
	"from" text NOT NULL,
	"from_name" text,
	"to" text,
	"subject" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text DEFAULT 'noise' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"classifier" text DEFAULT 'rules' NOT NULL,
	"extracted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order_id" text,
	"match_reason" text,
	"proposal" jsonb DEFAULT '{"action":"none","summary":""}'::jsonb NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mail_messages_tenant" ON "mail_messages" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_messages_message" ON "mail_messages" USING btree ("tenant_id","message_id");--> statement-breakpoint
CREATE INDEX "mail_messages_order" ON "mail_messages" USING btree ("order_id");