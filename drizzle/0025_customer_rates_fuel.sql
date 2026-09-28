CREATE TABLE "customer_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"origin_zone" text NOT NULL,
	"destination_zone" text NOT NULL,
	"equipment" text,
	"rate_type" text DEFAULT 'flat' NOT NULL,
	"rate_cents" integer NOT NULL,
	"minimum_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"fuel_rule" text DEFAULT 'included' NOT NULL,
	"fuel_value" integer,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fuel_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"week_of" text NOT NULL,
	"price_cents" integer NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fuel_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"method" text DEFAULT 'pct' NOT NULL,
	"bands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fuel_cents_per_mile" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_rate_id" text;--> statement-breakpoint
CREATE INDEX "customer_rates_tenant_customer" ON "customer_rates" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_prices_tenant_week" ON "fuel_prices" USING btree ("tenant_id","week_of");--> statement-breakpoint
CREATE INDEX "fuel_tables_tenant" ON "fuel_tables" USING btree ("tenant_id");