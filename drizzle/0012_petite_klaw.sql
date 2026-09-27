ALTER TABLE "trailers" ADD COLUMN "max_weight_lbs" integer;--> statement-breakpoint
ALTER TABLE "trailers" ADD COLUMN "cube_ft" integer;--> statement-breakpoint
ALTER TABLE "trucks" ADD COLUMN "cargo_length_ft" integer;--> statement-breakpoint
ALTER TABLE "trucks" ADD COLUMN "max_weight_lbs" integer;--> statement-breakpoint
ALTER TABLE "trucks" ADD COLUMN "cube_ft" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "kind" text DEFAULT 'order' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "trip_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_stop_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_stop_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "load_seq" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pieces" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "weight_lbs" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "linear_ft" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cube_ft" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stackable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "hazmat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_trip" ON "orders" USING btree ("trip_id");