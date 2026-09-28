ALTER TABLE "carriers" ADD COLUMN "quick_pay_pct" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "detention_free_minutes" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "detention_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reminder_days" jsonb;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "crossing_pay_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fuel_pct" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tolls_fees_cents" integer;