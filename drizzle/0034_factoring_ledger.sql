CREATE TABLE "factor_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "billing_entities" ADD COLUMN "factor_advance_bp" integer;--> statement-breakpoint
ALTER TABLE "billing_entities" ADD COLUMN "factor_fee_bp" integer;--> statement-breakpoint
ALTER TABLE "billing_entities" ADD COLUMN "factor_recourse_days" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "factor_funded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "factor_entries_invoice" ON "factor_entries" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "factor_entries_entity" ON "factor_entries" USING btree ("tenant_id","entity_id","at");