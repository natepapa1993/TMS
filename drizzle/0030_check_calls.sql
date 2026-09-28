CREATE TABLE "check_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"leg_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"location" text,
	"lat" text,
	"lng" text,
	"status" text DEFAULT 'on_time' NOT NULL,
	"eta_at" timestamp with time zone,
	"temp_f" integer,
	"note" text,
	"source" text DEFAULT 'dispatcher' NOT NULL,
	"sent_to" text,
	"created_by" text
);
--> statement-breakpoint
CREATE INDEX "check_calls_tenant_order" ON "check_calls" USING btree ("tenant_id","order_id","at");