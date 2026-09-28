ALTER TABLE "customers" ALTER COLUMN "required_docs" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "required_docs" DROP NOT NULL;