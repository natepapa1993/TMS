CREATE TABLE "accounting_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"format" text NOT NULL,
	"from_date" text NOT NULL,
	"to_date" text NOT NULL,
	"only_new" boolean DEFAULT true NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "qb_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "qb_name" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "qb_name" text;--> statement-breakpoint
ALTER TABLE "carrier_bills" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "accounting_exports_tenant" ON "accounting_exports" USING btree ("tenant_id","created_at");