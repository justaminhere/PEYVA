ALTER TABLE "goals" ADD COLUMN "proposed_constraints" jsonb;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "proposed_hash" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "proposed_at" timestamp with time zone;