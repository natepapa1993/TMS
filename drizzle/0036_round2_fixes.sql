CREATE TABLE "override_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"order_id" text,
	"leg_id" text,
	"crossing_id" text,
	"subject_kind" text,
	"subject_id" text,
	"replay" jsonb NOT NULL,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "ca_broker_id" text;--> statement-breakpoint
ALTER TABLE "tenders" ADD COLUMN "counter_cents" integer;--> statement-breakpoint
ALTER TABLE "tenders" ADD COLUMN "counter_note" text;--> statement-breakpoint
ALTER TABLE "tenders" ADD COLUMN "counter_by" text;--> statement-breakpoint
ALTER TABLE "tenders" ADD COLUMN "counter_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "carrier_bills" ADD COLUMN "exchange_rate_e4" integer;--> statement-breakpoint
ALTER TABLE "pay_items" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "exchange_rate_e4" integer;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "exchange_rate_e4" integer;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "follow_up_months" integer;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "specimen_type" text;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "mro_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "observed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "sap_name" text;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "sap_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "sap_education_done_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "override_requests_tenant_state" ON "override_requests" USING btree ("tenant_id","state");