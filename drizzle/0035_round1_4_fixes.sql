ALTER TABLE "billing_entities" ADD COLUMN "next_credit_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_types" ADD COLUMN "block_level" text;--> statement-breakpoint
ALTER TABLE "trailers" ADD COLUMN "oos_reason" text;--> statement-breakpoint
ALTER TABLE "trailers" ADD COLUMN "oos_inspection_id" text;--> statement-breakpoint
ALTER TABLE "trucks" ADD COLUMN "oos_inspection_id" text;--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN "carrier_rate_currency" text;--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN "est_miles" integer;--> statement-breakpoint
ALTER TABLE "tenders" ADD COLUMN "unit_plate" text;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN "pdf_storage_key" text;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN "sent_to" text;--> statement-breakpoint
ALTER TABLE "factor_entries" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "supplement_of" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "dispute_resolution" text;--> statement-breakpoint
ALTER TABLE "pay_items" ADD COLUMN "original_cents" integer;--> statement-breakpoint
ALTER TABLE "pay_items" ADD COLUMN "carried_from" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "driver_oos_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "repair" jsonb;