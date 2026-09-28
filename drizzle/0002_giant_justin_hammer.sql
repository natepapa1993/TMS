CREATE TABLE "crossing_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"crossing_id" text NOT NULL,
	"code" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"values" jsonb,
	"override_reason" text,
	"override_by" text,
	"override_at" timestamp with time zone,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crossing_doc_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"provided_by" text DEFAULT 'mx_broker' NOT NULL,
	"required_when" text DEFAULT 'always' NOT NULL,
	"allow_na" boolean DEFAULT false NOT NULL,
	"last_document" boolean DEFAULT false NOT NULL,
	"packet_order" integer DEFAULT 50 NOT NULL,
	"port_id" text,
	"customer_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crossing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"crossing_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"source" text DEFAULT 'dispatcher' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"user_id" text,
	"note" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "crossings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"leg_id" text NOT NULL,
	"order_id" text NOT NULL,
	"port_id" text,
	"bridge" text,
	"state" text DEFAULT 'created' NOT NULL,
	"previous_state" text,
	"trailer_number" text,
	"seal_number" text,
	"arrived_yard_at" timestamp with time zone,
	"departed_yard_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"held_reason" text,
	"held_at" timestamp with time zone,
	"returned_reason" text,
	"packet_storage_key" text,
	"packet_built_at" timestamp with time zone,
	"packet_sent_at" timestamp with time zone,
	"packet_ack_at" timestamp with time zone,
	"packet_token" text,
	"requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eligibility" jsonb,
	"eligibility_override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "crossing_checks_crossing_code" ON "crossing_checks" USING btree ("crossing_id","code");--> statement-breakpoint
CREATE INDEX "crossing_doc_rules_tenant" ON "crossing_doc_rules" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "crossing_events_crossing_at" ON "crossing_events" USING btree ("crossing_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "crossings_leg" ON "crossings" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "crossings_tenant_state" ON "crossings" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "crossings_tenant_order" ON "crossings" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "document_blobs_tenant_sha" ON "document_blobs" USING btree ("tenant_id","sha256");