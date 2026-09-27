ALTER TABLE "carriers" ADD COLUMN "nsc_number" text;--> statement-breakpoint
ALTER TABLE "trucks" ADD COLUMN "ca_plate" text;--> statement-breakpoint
ALTER TABLE "trucks" ADD COLUMN "ca_plate_province" text;--> statement-breakpoint
ALTER TABLE "trucks" ADD COLUMN "ca_plate_expires" timestamp with time zone;