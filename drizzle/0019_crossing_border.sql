ALTER TABLE "crossing_doc_rules" ADD COLUMN "border" text DEFAULT 'mx' NOT NULL;--> statement-breakpoint
ALTER TABLE "crossing_doc_rules" ADD COLUMN "direction" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "crossings" ADD COLUMN "from_country" text DEFAULT 'MX' NOT NULL;--> statement-breakpoint
ALTER TABLE "crossings" ADD COLUMN "to_country" text DEFAULT 'US' NOT NULL;--> statement-breakpoint
UPDATE "crossing_doc_rules" SET "border" = 'any' WHERE "code" IN ('bol', 'invoice', 'packing_list');--> statement-breakpoint
UPDATE "crossing_doc_rules" SET "border" = 'any', "direction" = 'into_us' WHERE "code" IN ('ace_manifest', 'entry', 'dtops');--> statement-breakpoint
UPDATE "crossings" c SET "from_country" = upper(f."country"), "to_country" = upper(t."country") FROM "legs" l, "stops" f, "stops" t WHERE l."id" = c."leg_id" AND f."id" = l."from_stop_id" AND t."id" = l."to_stop_id";
