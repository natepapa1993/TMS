CREATE TABLE "compliance_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "compliance_snoozes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"item_key" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "compliance_status" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"dispatchable" boolean DEFAULT true NOT NULL,
	"expired" text[] DEFAULT '{}' NOT NULL,
	"expiring" text[] DEFAULT '{}' NOT NULL,
	"missing" text[] DEFAULT '{}' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"kind" text DEFAULT 'accident' NOT NULL,
	"driver_id" text,
	"truck_id" text,
	"trailer_id" text,
	"order_id" text,
	"location" text,
	"description" text NOT NULL,
	"dot_recordable" boolean DEFAULT false NOT NULL,
	"injuries" boolean DEFAULT false NOT NULL,
	"tow_away" boolean DEFAULT false NOT NULL,
	"police_report" text,
	"claim_number" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "compliance_overrides_subject" ON "compliance_overrides" USING btree ("tenant_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "compliance_snoozes_subject" ON "compliance_snoozes" USING btree ("tenant_id","subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_status_subject" ON "compliance_status" USING btree ("tenant_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "compliance_status_tenant" ON "compliance_status" USING btree ("tenant_id","dispatchable");--> statement-breakpoint
CREATE INDEX "incidents_tenant_at" ON "incidents" USING btree ("tenant_id","occurred_at");