CREATE TYPE "public"."alert_state" AS ENUM('ok', 'warn', 'alert', 'no_data');--> statement-breakpoint
CREATE TYPE "public"."audit_kind" AS ENUM('alert_created', 'alert_updated', 'alert_archived', 'state_changed', 'remediation_created', 'remediation_updated', 'remediation_run', 'dependencies_updated');--> statement-breakpoint
CREATE TYPE "public"."event_outcome" AS ENUM('applied', 'unchanged', 'stale', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."remediation_mode" AS ENUM('webhook', 'api');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('success', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"application_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"state" "alert_state" DEFAULT 'no_data' NOT NULL,
	"priority" smallint,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"link" text,
	"last_event_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_provider_external_id_key" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "application_dependencies" (
	"app_id" bigint NOT NULL,
	"depends_on_id" bigint NOT NULL,
	CONSTRAINT "application_dependencies_app_id_depends_on_id_pk" PRIMARY KEY("app_id","depends_on_id"),
	CONSTRAINT "application_dependencies_no_self" CHECK ("application_dependencies"."app_id" <> "application_dependencies"."depends_on_id")
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "applications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "audit_kind" NOT NULL,
	"actor" text NOT NULL,
	"alert_id" bigint,
	"application_id" bigint,
	"from_state" "alert_state",
	"to_state" "alert_state",
	"event_id" bigint,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remediation_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "remediation_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"remediation_id" bigint NOT NULL,
	"alert_id" bigint NOT NULL,
	"event_id" bigint,
	"trigger_state" "alert_state" NOT NULL,
	"status" "run_status" NOT NULL,
	"http_status" smallint,
	"duration_ms" integer,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remediations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "remediations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"alert_id" bigint NOT NULL,
	"name" text NOT NULL,
	"mode" "remediation_mode" NOT NULL,
	"url" text NOT NULL,
	"method" text DEFAULT 'POST' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_template" text,
	"trigger_states" "alert_state"[] DEFAULT '{alert}'::alert_state[] NOT NULL,
	"timeout_ms" integer DEFAULT 5000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remediations_timeout_range" CHECK ("remediations"."timeout_ms" between 100 and 15000)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"alert_id" bigint,
	"outcome" "event_outcome" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "webhook_events_provider_event_key" UNIQUE("provider","external_event_id")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_dependencies" ADD CONSTRAINT "application_dependencies_app_id_applications_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_dependencies" ADD CONSTRAINT "application_dependencies_depends_on_id_applications_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_runs" ADD CONSTRAINT "remediation_runs_remediation_id_remediations_id_fk" FOREIGN KEY ("remediation_id") REFERENCES "public"."remediations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_runs" ADD CONSTRAINT "remediation_runs_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_runs" ADD CONSTRAINT "remediation_runs_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_application_state_idx" ON "alerts" USING btree ("application_id","state") WHERE "alerts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "application_dependencies_depends_on_id_idx" ON "application_dependencies" USING btree ("depends_on_id");--> statement-breakpoint
CREATE INDEX "audit_log_alert_id_idx" ON "audit_log" USING btree ("alert_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_application_id_idx" ON "audit_log" USING btree ("application_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_event_id_idx" ON "audit_log" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "remediation_runs_alert_id_idx" ON "remediation_runs" USING btree ("alert_id","at");--> statement-breakpoint
CREATE INDEX "remediation_runs_remediation_id_idx" ON "remediation_runs" USING btree ("remediation_id");--> statement-breakpoint
CREATE INDEX "remediation_runs_event_id_idx" ON "remediation_runs" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "remediations_alert_id_idx" ON "remediations" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "webhook_events_alert_id_idx" ON "webhook_events" USING btree ("alert_id");