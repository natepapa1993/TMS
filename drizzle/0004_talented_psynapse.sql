CREATE TABLE "carrier_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"carrier_id" text NOT NULL,
	"order_id" text NOT NULL,
	"leg_id" text NOT NULL,
	"tender_id" text,
	"state" text DEFAULT 'expected' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"expected_cents" integer DEFAULT 0 NOT NULL,
	"accessorial_cents" integer DEFAULT 0 NOT NULL,
	"invoiced_cents" integer,
	"approved_cents" integer,
	"carrier_invoice_number" text,
	"carrier_invoice_doc_id" text,
	"received_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"short_pay_note" text,
	"pay_date" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_cents" integer,
	"method" text,
	"reference" text,
	"quick_pay_pct" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"leg_id" text,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit" text DEFAULT 'flat' NOT NULL,
	"rate_cents" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"data" jsonb,
	"invoice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_memos" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"number" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"number" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"order_ids" text[] DEFAULT '{}' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate_e4" integer,
	"terms_days" integer DEFAULT 30 NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"credited_cents" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb,
	"pdf_storage_key" text,
	"token" text,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"dispute_reason" text,
	"dispute_expected_at" timestamp with time zone,
	"promise_to_pay_at" timestamp with time zone,
	"pay_when_paid" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pay_items" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"recurring" boolean DEFAULT false NOT NULL,
	"remaining_cents" integer,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"method" text DEFAULT 'ach' NOT NULL,
	"reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"deductions_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"reviewed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"method" text,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_bills_leg" ON "carrier_bills" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "carrier_bills_tenant_state" ON "carrier_bills" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "carrier_bills_tenant_carrier" ON "carrier_bills" USING btree ("tenant_id","carrier_id");--> statement-breakpoint
CREATE INDEX "charges_tenant_order" ON "charges" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "charges_invoice" ON "charges" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "credit_memos_invoice" ON "credit_memos" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_tenant_state" ON "invoices" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "invoices_tenant_customer" ON "invoices" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "pay_items_driver" ON "pay_items" USING btree ("tenant_id","driver_id","active");--> statement-breakpoint
CREATE INDEX "receipts_invoice" ON "receipts" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_driver_period" ON "settlements" USING btree ("tenant_id","driver_id","period_start");--> statement-breakpoint
CREATE INDEX "settlements_tenant_state" ON "settlements" USING btree ("tenant_id","state");