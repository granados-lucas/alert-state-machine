ALTER TYPE "public"."audit_kind" ADD VALUE 'monitor_muted';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'monitor_unmuted';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'monitor_mute_failed';--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "muted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "muted_scope" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "mute_reason" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "muted_by" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "muted_at" timestamp with time zone;