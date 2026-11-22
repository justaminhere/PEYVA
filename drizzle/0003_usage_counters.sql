CREATE TABLE "usage_counters" (
	"period" text NOT NULL,
	"key" text NOT NULL,
	"n" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_period_key" ON "usage_counters" USING btree ("period","key");