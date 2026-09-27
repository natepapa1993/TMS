CREATE TABLE "access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"token" text NOT NULL,
	"label" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"last_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"channel" text NOT NULL,
	"to" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"html" text,
	"subject_kind" text,
	"subject_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"truck_id" text,
	"driver_id" text,
	"leg_id" text,
	"order_id" text,
	"lat" text NOT NULL,
	"lng" text NOT NULL,
	"speed_mph" integer,
	"heading" integer,
	"accuracy_m" integer,
	"place" text,
	"external_id" text
);
--> statement-breakpoint
CREATE TABLE "tenders" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"leg_id" text NOT NULL,
	"order_id" text NOT NULL,
	"carrier_id" text NOT NULL,
	"rate_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"state" text DEFAULT 'sent' NOT NULL,
	"token" text NOT NULL,
	"sent_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"responded_by" text,
	"response_note" text,
	"driver_name" text,
	"driver_phone" text,
	"unit_number" text,
	"trailer_number" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "access_tokens_token" ON "access_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "access_tokens_tenant_subject" ON "access_tokens" USING btree ("tenant_id","kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_tenant_provider" ON "integrations" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "outbox_tenant_state" ON "outbox" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "outbox_subject" ON "outbox" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "positions_tenant_truck_at" ON "positions" USING btree ("tenant_id","truck_id","at");--> statement-breakpoint
CREATE INDEX "positions_tenant_leg_at" ON "positions" USING btree ("tenant_id","leg_id","at");--> statement-breakpoint
CREATE INDEX "positions_tenant_order" ON "positions" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "tenders_tenant_leg" ON "tenders" USING btree ("tenant_id","leg_id");--> statement-breakpoint
CREATE INDEX "tenders_tenant_state" ON "tenders" USING btree ("tenant_id","state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenders_token" ON "tenders" USING btree ("token");