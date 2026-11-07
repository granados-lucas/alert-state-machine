CREATE TYPE "public"."combination_rule" AS ENUM('and', 'or', 'at_least');--> statement-breakpoint
CREATE TYPE "public"."combination_state" AS ENUM('ok', 'pending', 'alert');--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'combination_created';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'combination_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'combination_archived';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'combination_state_changed';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'combination_automation_created';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'combination_automation_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'combination_automation_run';--> statement-breakpoint
CREATE TABLE "combination_alerts" (
	"combination_id" bigint NOT NULL,
	"alert_id" bigint NOT NULL,
	CONSTRAINT "combination_alerts_combination_id_alert_id_pk" PRIMARY KEY("combination_id","alert_id")
);
--> statement-breakpoint
CREATE TABLE "combination_automation_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "combination_automation_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"automation_id" bigint NOT NULL,
	"combination_id" bigint NOT NULL,
	"trigger_state" "combination_state" NOT NULL,
	"status" "run_status" NOT NULL,
	"http_status" smallint,
	"duration_ms" integer,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "combination_automations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "combination_automations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"combination_id" bigint NOT NULL,
	"name" text NOT NULL,
	"mode" "remediation_mode" NOT NULL,
	"url" text NOT NULL,
	"method" text DEFAULT 'POST' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_template" text,
	"trigger_states" "combination_state"[] DEFAULT '{alert}'::combination_state[] NOT NULL,
	"timeout_ms" integer DEFAULT 5000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "combination_automations_timeout_range" CHECK ("combination_automations"."timeout_ms" between 100 and 15000),
	CONSTRAINT "combination_automations_no_pending_trigger" CHECK (not ('pending' = any("combination_automations"."trigger_states")))
);
--> statement-breakpoint
CREATE TABLE "combination_evaluator_heartbeat" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	CONSTRAINT "combination_evaluator_heartbeat_single_row" CHECK ("combination_evaluator_heartbeat"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "combinations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "combinations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"description" text,
	"rule" "combination_rule" NOT NULL,
	"min_count" smallint,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"state" "combination_state" DEFAULT 'ok' NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"satisfied_since" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "combinations_name_unique" UNIQUE("name"),
	CONSTRAINT "combinations_duration_range" CHECK ("combinations"."duration_seconds" between 0 and 86400),
	CONSTRAINT "combinations_min_count_rule" CHECK (("combinations"."rule" = 'at_least' and "combinations"."min_count" is not null and "combinations"."min_count" >= 1) or ("combinations"."rule" <> 'at_least' and "combinations"."min_count" is null))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "combination_id" bigint;--> statement-breakpoint
ALTER TABLE "combination_alerts" ADD CONSTRAINT "combination_alerts_combination_id_combinations_id_fk" FOREIGN KEY ("combination_id") REFERENCES "public"."combinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combination_alerts" ADD CONSTRAINT "combination_alerts_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combination_automation_runs" ADD CONSTRAINT "combination_automation_runs_automation_id_combination_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."combination_automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combination_automation_runs" ADD CONSTRAINT "combination_automation_runs_combination_id_combinations_id_fk" FOREIGN KEY ("combination_id") REFERENCES "public"."combinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combination_automations" ADD CONSTRAINT "combination_automations_combination_id_combinations_id_fk" FOREIGN KEY ("combination_id") REFERENCES "public"."combinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "combination_alerts_alert_id_idx" ON "combination_alerts" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "combination_automation_runs_combination_id_idx" ON "combination_automation_runs" USING btree ("combination_id","at");--> statement-breakpoint
CREATE INDEX "combination_automation_runs_automation_id_idx" ON "combination_automation_runs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "combination_automations_combination_id_idx" ON "combination_automations" USING btree ("combination_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_combination_id_combinations_id_fk" FOREIGN KEY ("combination_id") REFERENCES "public"."combinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_combination_id_idx" ON "audit_log" USING btree ("combination_id","id");