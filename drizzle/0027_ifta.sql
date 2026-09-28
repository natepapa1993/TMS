CREATE TABLE "fuel_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"truck_id" text,
	"driver_id" text,
	"purchased_at" timestamp with time zone NOT NULL,
	"jurisdiction" text NOT NULL,
	"gallons_milli" integer NOT NULL,
	"fuel_type" text DEFAULT 'diesel' NOT NULL,
	"amount_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"vendor" text,
	"city" text,
	"receipt_number" text,
	"tax_paid" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ifta_miles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"quarter" text NOT NULL,
	"truck_id" text NOT NULL,
	"date" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"miles_tenths" integer NOT NULL,
	"source" text NOT NULL,
	"leg_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ifta_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"quarter" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"rate_e4" integer NOT NULL,
	"surcharge_e4" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "fuel_purchases_tenant_at" ON "fuel_purchases" USING btree ("tenant_id","purchased_at");--> statement-breakpoint
CREATE INDEX "fuel_purchases_tenant_truck" ON "fuel_purchases" USING btree ("tenant_id","truck_id");--> statement-breakpoint
CREATE INDEX "ifta_miles_tenant_quarter" ON "ifta_miles" USING btree ("tenant_id","quarter","truck_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ifta_rates_tenant_quarter_j" ON "ifta_rates" USING btree ("tenant_id","quarter","jurisdiction");