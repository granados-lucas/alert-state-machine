ALTER TABLE "alerts" ADD COLUMN "provider_state" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "provider_state_at" timestamp with time zone;