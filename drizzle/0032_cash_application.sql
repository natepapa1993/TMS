CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"method" text DEFAULT 'ach' NOT NULL,
	"reference" text,
	"remittance" text,
	"note" text,
	"applied_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "accessorial_approval" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "approval_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "approval_ref" text;--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "rejected_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "kind" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "rebill_of" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "payment_id" text;--> statement-breakpoint
CREATE INDEX "payments_tenant_customer" ON "payments" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "receipts_payment" ON "receipts" USING btree ("payment_id");