ALTER TABLE "billing_entities" ADD COLUMN "next_credit_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN "carrier_rate_currency" text;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN "pdf_storage_key" text;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN "sent_to" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "supplement_of" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "dispute_resolution" text;--> statement-breakpoint
ALTER TABLE "pay_items" ADD COLUMN "original_cents" integer;--> statement-breakpoint
ALTER TABLE "pay_items" ADD COLUMN "carried_from" text;