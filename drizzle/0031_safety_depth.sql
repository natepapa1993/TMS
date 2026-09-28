CREATE TABLE "da_draws" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"period" text NOT NULL,
	"drawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pool_size" integer NOT NULL,
	"pool_driver_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"drug_rate" integer NOT NULL,
	"alcohol_rate" integer NOT NULL,
	"draws_per_year" integer DEFAULT 4 NOT NULL,
	"drug_count" integer NOT NULL,
	"alcohol_count" integer NOT NULL,
	"drawn_by" text
);
--> statement-breakpoint
CREATE TABLE "da_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"reason" text NOT NULL,
	"substance" text NOT NULL,
	"draw_id" text,
	"incident_id" text,
	"selected_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"result" text DEFAULT 'pending' NOT NULL,
	"result_at" timestamp with time zone,
	"specimen_id" text,
	"collector" text,
	"mro" text,
	"follow_up_planned" integer,
	"clearinghouse_reported_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dq_records" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"item_key" text NOT NULL,
	"completed_at" timestamp with time zone,
	"not_required" boolean DEFAULT false NOT NULL,
	"note" text,
	"document_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"inspected_at" timestamp with time zone NOT NULL,
	"report_number" text,
	"country" text DEFAULT 'US' NOT NULL,
	"jurisdiction" text,
	"level" integer DEFAULT 1 NOT NULL,
	"hazmat" boolean DEFAULT false NOT NULL,
	"driver_id" text,
	"truck_id" text,
	"trailer_id" text,
	"order_id" text,
	"location" text,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_qs" text DEFAULT 'none' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "fatality" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "citation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "preventable" text;--> statement-breakpoint
CREATE UNIQUE INDEX "da_draws_period" ON "da_draws" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE INDEX "da_tests_driver" ON "da_tests" USING btree ("tenant_id","driver_id");--> statement-breakpoint
CREATE INDEX "da_tests_tenant" ON "da_tests" USING btree ("tenant_id","selected_at");--> statement-breakpoint
CREATE INDEX "dq_records_driver" ON "dq_records" USING btree ("tenant_id","driver_id","item_key");--> statement-breakpoint
CREATE INDEX "inspections_tenant_at" ON "inspections" USING btree ("tenant_id","inspected_at");--> statement-breakpoint
CREATE INDEX "inspections_driver" ON "inspections" USING btree ("tenant_id","driver_id");