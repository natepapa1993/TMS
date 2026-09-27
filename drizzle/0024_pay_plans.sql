CREATE TABLE "pay_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"team_split" text DEFAULT 'half' NOT NULL,
	"minimum_cents" integer,
	"per_diem_cents" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "pay_plan_id" text;--> statement-breakpoint
ALTER TABLE "pay_items" ADD COLUMN "target_cents" integer;--> statement-breakpoint
ALTER TABLE "pay_items" ADD COLUMN "balance_cents" integer;--> statement-breakpoint
CREATE INDEX "pay_plans_tenant" ON "pay_plans" USING btree ("tenant_id");