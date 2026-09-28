CREATE TABLE "override_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"order_id" text,
	"leg_id" text,
	"crossing_id" text,
	"subject_kind" text,
	"subject_id" text,
	"replay" jsonb NOT NULL,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "override_requests_tenant_state" ON "override_requests" USING btree ("tenant_id","state");