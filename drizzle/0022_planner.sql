CREATE TABLE "asset_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"hard" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "dispatcher_user_id" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "hos_drive_min" integer;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "hos_shift_min" integer;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "hos_cycle_min" integer;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "hos_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "asset_events_subject" ON "asset_events" USING btree ("tenant_id","subject_kind","subject_id");