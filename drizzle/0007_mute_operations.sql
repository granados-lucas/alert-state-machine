CREATE TYPE "public"."mute_action" AS ENUM('mute', 'unmute');--> statement-breakpoint
CREATE TYPE "public"."mute_operation_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "mute_operations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mute_operations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"alert_id" bigint NOT NULL,
	"action" "mute_action" NOT NULL,
	"status" "mute_operation_status" DEFAULT 'pending' NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"minutes" integer,
	"until" timestamp with time zone,
	"scope" text,
	"all_scopes" boolean DEFAULT false NOT NULL,
	"recovered" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mute_operations" ADD CONSTRAINT "mute_operations_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mute_operations_one_pending_idx" ON "mute_operations" USING btree ("alert_id") WHERE "mute_operations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "mute_operations_alert_id_idx" ON "mute_operations" USING btree ("alert_id","id");