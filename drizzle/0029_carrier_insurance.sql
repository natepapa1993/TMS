ALTER TABLE "carriers" ADD COLUMN "auto_liability_cents" integer;--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "auto_liability_expires" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "cargo_coverage_cents" integer;--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "cargo_insurance_expires" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "insurer" text;