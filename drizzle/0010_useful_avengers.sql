CREATE TABLE "inbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"channel" text NOT NULL,
	"from" text NOT NULL,
	"from_name" text,
	"body" text NOT NULL,
	"provider_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"driver_id" text,
	"carrier_id" text,
	"leg_id" text,
	"order_id" text,
	"handled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "inbound_messages_tenant" ON "inbound_messages" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_provider" ON "inbound_messages" USING btree ("tenant_id","provider_id");