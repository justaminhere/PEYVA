ALTER TABLE "conversations" ADD COLUMN "state" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "updated_at" timestamp with time zone;