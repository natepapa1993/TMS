ALTER TABLE "document_types" ADD COLUMN "block_level" text;--> statement-breakpoint
ALTER TABLE "trailers" ADD COLUMN "oos_reason" text;--> statement-breakpoint
ALTER TABLE "trailers" ADD COLUMN "oos_inspection_id" text;--> statement-breakpoint
ALTER TABLE "trucks" ADD COLUMN "oos_inspection_id" text;--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "driver_oos_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "repair" jsonb;