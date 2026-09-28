CREATE TABLE "order_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"kind" text DEFAULT 'general' NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "priority" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "rate_type" text DEFAULT 'flat' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "rate_unit_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "rate_qty" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sales_agent_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "csr_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dispatcher_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tonu" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "order_notes_tenant_order" ON "order_notes" USING btree ("tenant_id","order_id");