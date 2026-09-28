ALTER TABLE "pay_items" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "exchange_rate_e4" integer;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "exchange_rate_e4" integer;