CREATE TABLE "edi_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"direction" text NOT NULL,
	"type" text NOT NULL,
	"control_number" text,
	"functional_id" text,
	"order_id" text,
	"leg_id" text,
	"invoice_id" text,
	"subject_key" text,
	"summary" text NOT NULL,
	"content" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"outbox_id" text,
	"acked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "edi_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"usage" text DEFAULT 'T' NOT NULL,
	"our_qualifier" text DEFAULT '02' NOT NULL,
	"our_id" text NOT NULL,
	"their_qualifier" text DEFAULT 'ZZ' NOT NULL,
	"their_id" text NOT NULL,
	"scac" text NOT NULL,
	"send_214" boolean DEFAULT true NOT NULL,
	"send_210" boolean DEFAULT false NOT NULL,
	"accept_204" boolean DEFAULT true NOT NULL,
	"auto_create_orders" boolean DEFAULT true NOT NULL,
	"delivery" text DEFAULT 'pickup' NOT NULL,
	"delivery_email" text,
	"status_map" jsonb,
	"charge_codes" jsonb,
	"next_control" integer DEFAULT 1 NOT NULL,
	"inbound_token" text NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "edi_messages_tenant" ON "edi_messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "edi_messages_partner" ON "edi_messages" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "edi_messages_subject" ON "edi_messages" USING btree ("tenant_id","subject_key");--> statement-breakpoint
CREATE UNIQUE INDEX "edi_partners_tenant_customer" ON "edi_partners" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "edi_partners_token" ON "edi_partners" USING btree ("inbound_token");