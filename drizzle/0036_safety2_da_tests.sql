ALTER TABLE "da_tests" ADD COLUMN "follow_up_months" integer;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "specimen_type" text;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "mro_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "observed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "sap_name" text;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "sap_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "da_tests" ADD COLUMN "sap_education_done_at" timestamp with time zone;