CREATE TYPE "public"."reconciliation_status" AS ENUM('running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'reconciliation_run';--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reconciliation_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"trigger" text NOT NULL,
	"actor" text NOT NULL,
	"status" "reconciliation_status" DEFAULT 'running' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rate_limit" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_one_running_idx" ON "reconciliation_runs" USING btree ("provider") WHERE "reconciliation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "reconciliation_runs_started_at_idx" ON "reconciliation_runs" USING btree ("started_at");