CREATE TABLE "invoice_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text DEFAULT 'billing' NOT NULL,
	"number" integer NOT NULL,
	"invoice_ids" text[] DEFAULT '{}' NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"sent_to" text,
	"storage_key" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_entities" ADD COLUMN "factor_name" text;--> statement-breakpoint
ALTER TABLE "billing_entities" ADD COLUMN "factor_email" text;--> statement-breakpoint
ALTER TABLE "billing_entities" ADD COLUMN "factor_remit_to" jsonb;--> statement-breakpoint
ALTER TABLE "billing_entities" ADD COLUMN "factor_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_entities" ADD COLUMN "factor_notice" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_mode" text DEFAULT 'per_load' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_delivery" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_cc" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_docs" jsonb;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "portal_url" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "factored" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "batch_id" text;--> statement-breakpoint
CREATE INDEX "invoice_batches_tenant" ON "invoice_batches" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_batches_tenant_kind_number" ON "invoice_batches" USING btree ("tenant_id","kind","number");