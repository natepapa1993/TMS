CREATE TYPE "public"."role" AS ENUM('owner', 'dispatcher', 'billing', 'compliance', 'mx_office', 'driver', 'carrier', 'customer');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "billing_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"legal_name" text NOT NULL,
	"dba" text,
	"country" text DEFAULT 'US' NOT NULL,
	"tax_id" text,
	"mc_number" text,
	"dot_number" text,
	"scac" text,
	"caat" text,
	"remit_to" jsonb,
	"invoice_prefix" text NOT NULL,
	"next_invoice_number" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"terms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "carrier_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"carrier_id" text NOT NULL,
	"origin_location_id" text,
	"origin_zone" text,
	"destination_location_id" text,
	"destination_zone" text,
	"equipment" text DEFAULT '53_dry' NOT NULL,
	"rate_cents" integer NOT NULL,
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
CREATE TABLE "carriers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"kind" text DEFAULT 'any' NOT NULL,
	"mc_number" text,
	"dot_number" text,
	"scac" text,
	"rfc" text,
	"caat" text,
	"caat_expires" timestamp with time zone,
	"sct_permit" text,
	"sct_permit_expires" timestamp with time zone,
	"ctpat" boolean DEFAULT false NOT NULL,
	"ctpat_expires" timestamp with time zone,
	"tender_channel" text DEFAULT 'email' NOT NULL,
	"dispatch_email" text,
	"dispatch_phone" text,
	"whatsapp" text,
	"plate_classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"port_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fmcsa_status" jsonb,
	"do_not_use" boolean DEFAULT false NOT NULL,
	"do_not_use_reason" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'customer' NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"mc_number" text,
	"dot_number" text,
	"billing_entity_id" text,
	"billing_email" text,
	"terms_days" integer DEFAULT 30 NOT NULL,
	"pay_when_paid" boolean DEFAULT false NOT NULL,
	"tracking_requirement" text DEFAULT 'link' NOT NULL,
	"required_docs" jsonb DEFAULT '["POD","BOL","RATE_CON"]'::jsonb NOT NULL,
	"mx_broker_id" text,
	"us_broker_id" text,
	"knowledge_md" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customs_brokers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"patente" text,
	"filer_code" text,
	"portal_url" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"applies_to" text NOT NULL,
	"tracks_expiry" boolean DEFAULT true NOT NULL,
	"alert_days" jsonb DEFAULT '[30]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"blocks_dispatch" boolean DEFAULT false NOT NULL,
	"leg_scope" text,
	"grace_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"document_type_id" text,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"number" text,
	"source" text DEFAULT 'upload' NOT NULL,
	"status" text DEFAULT 'present' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"extracted" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"driver_type" text DEFAULT 'CDL' NOT NULL,
	"phone" text,
	"whatsapp" text,
	"user_id" text,
	"license_number" text,
	"license_state" text,
	"license_class" text,
	"license_expires" timestamp with time zone,
	"mx_license_number" text,
	"mx_license_expires" timestamp with time zone,
	"medical_expires" timestamp with time zone,
	"fast_number" text,
	"fast_expires" timestamp with time zone,
	"visa_type" text,
	"i94_until" timestamp with time zone,
	"elp_attested_at" timestamp with time zone,
	"commercial_zone_only" boolean DEFAULT false NOT NULL,
	"non_domiciled_cdl" boolean DEFAULT false NOT NULL,
	"hire_date" timestamp with time zone,
	"pay_type" text DEFAULT 'per_mile' NOT NULL,
	"pay_rate_cents" integer,
	"home_terminal_id" text,
	"eld_driver_id" text,
	"current_truck_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"entity" text NOT NULL,
	"file_name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'shipper' NOT NULL,
	"address" jsonb NOT NULL,
	"country" text NOT NULL,
	"lat" text,
	"lng" text,
	"geofence_meters" integer DEFAULT 300 NOT NULL,
	"hours" text,
	"contact_name" text,
	"contact_phone" text,
	"notes" text,
	"port_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ports" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"us_city" text,
	"us_state" text,
	"mx_city" text,
	"mx_state" text,
	"bridges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"knowledge_md" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"time_zone" text DEFAULT 'America/Detroit' NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "trailers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"unit_number" text NOT NULL,
	"vin" text,
	"kind" text DEFAULT '53_dry' NOT NULL,
	"length_ft" integer,
	"us_plate" text,
	"mx_plate" text,
	"inspection_expires" timestamp with time zone,
	"ownership" text DEFAULT 'company' NOT NULL,
	"gps_device_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trucks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"unit_number" text NOT NULL,
	"vin" text,
	"year" integer,
	"make" text,
	"model" text,
	"equipment_type" text DEFAULT 'tractor' NOT NULL,
	"ownership" text DEFAULT 'company' NOT NULL,
	"us_plate" text,
	"us_plate_state" text,
	"us_plate_expires" timestamp with time zone,
	"mx_plate" text,
	"mx_plate_class" text,
	"mx_plate_expires" timestamp with time zone,
	"entity_id" text,
	"caat" text,
	"scac" text,
	"eld_provider" text,
	"eld_vehicle_id" text,
	"dot_inspection_expires" timestamp with time zone,
	"dtops_year" integer,
	"dtops_confirmation" text,
	"status" text DEFAULT 'active' NOT NULL,
	"oos_reason" text,
	"oos_until" timestamp with time zone,
	"note" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"role" "role" DEFAULT 'dispatcher' NOT NULL,
	"phone" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"leg_id" text,
	"code" text NOT NULL,
	"level" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"owner" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "leg_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"leg_id" text NOT NULL,
	"order_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"source" text DEFAULT 'dispatcher' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"lat" text,
	"lng" text,
	"stop_id" text,
	"user_id" text,
	"note" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "legs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"from_stop_id" text,
	"to_stop_id" text,
	"state" text DEFAULT 'unassigned' NOT NULL,
	"assignee_kind" text,
	"truck_id" text,
	"trailer_id" text,
	"driver_id" text,
	"co_driver_id" text,
	"carrier_id" text,
	"carrier_rate_cents" integer,
	"planned_start" timestamp with time zone,
	"planned_end" timestamp with time zone,
	"planned_miles" integer,
	"plan_reason" text,
	"dispatched_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"hold_reason" text,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"body" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_number" text NOT NULL,
	"customer_id" text,
	"broker_id" text,
	"billing_entity_id" text,
	"port_id" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"previous_state" text,
	"equipment" text DEFAULT '53_dry' NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rate_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"rate_tbd" boolean DEFAULT false NOT NULL,
	"fuel_rule" text DEFAULT 'included' NOT NULL,
	"freight" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cargo_note" text,
	"leg_template" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"hold_reason" text,
	"cancel_reason" text,
	"delivered_at" timestamp with time zone,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stops" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"location_id" text,
	"name" text NOT NULL,
	"address" jsonb,
	"country" text DEFAULT 'US' NOT NULL,
	"lat" text,
	"lng" text,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"appointment" boolean DEFAULT false NOT NULL,
	"contact" text,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"arrived_at" timestamp with time zone,
	"departed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "audit_tenant_entity" ON "audit_log" USING btree ("tenant_id","entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_tenant_at" ON "audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "billing_entities_tenant" ON "billing_entities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "carrier_rates_tenant_carrier" ON "carrier_rates" USING btree ("tenant_id","carrier_id");--> statement-breakpoint
CREATE INDEX "carriers_tenant" ON "carriers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "customers_tenant" ON "customers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_name_country" ON "customers" USING btree ("tenant_id","name","country");--> statement-breakpoint
CREATE INDEX "customs_brokers_tenant" ON "customs_brokers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_types_tenant_name_applies" ON "document_types" USING btree ("tenant_id","name","applies_to");--> statement-breakpoint
CREATE INDEX "documents_tenant_subject" ON "documents" USING btree ("tenant_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "drivers_tenant" ON "drivers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "import_jobs_tenant" ON "import_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "locations_tenant" ON "locations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ports_tenant" ON "ports" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trailers_tenant_unit" ON "trailers" USING btree ("tenant_id","unit_number");--> statement-breakpoint
CREATE INDEX "trailers_tenant" ON "trailers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trucks_tenant_unit" ON "trucks" USING btree ("tenant_id","unit_number");--> statement-breakpoint
CREATE INDEX "trucks_tenant" ON "trucks" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "users_tenant" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "flags_tenant_open" ON "flags" USING btree ("tenant_id","cleared_at");--> statement-breakpoint
CREATE INDEX "flags_tenant_order" ON "flags" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "leg_events_tenant_leg" ON "leg_events" USING btree ("tenant_id","leg_id","at");--> statement-breakpoint
CREATE INDEX "leg_events_tenant_order" ON "leg_events" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "legs_tenant_order" ON "legs" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "legs_tenant_state" ON "legs" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "legs_tenant_truck" ON "legs" USING btree ("tenant_id","truck_id");--> statement-breakpoint
CREATE INDEX "notes_tenant_subject" ON "notes" USING btree ("tenant_id","subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_number" ON "orders" USING btree ("tenant_id","order_number");--> statement-breakpoint
CREATE INDEX "orders_tenant_state" ON "orders" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "stops_tenant_order" ON "stops" USING btree ("tenant_id","order_id");