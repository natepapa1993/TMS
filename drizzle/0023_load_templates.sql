CREATE TABLE "load_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"customer_id" text,
	"data" jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"times_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "load_templates_tenant" ON "load_templates" USING btree ("tenant_id");