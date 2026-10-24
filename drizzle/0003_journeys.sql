ALTER TYPE "public"."audit_kind" ADD VALUE 'journey_created';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'journey_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'journey_applications_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_kind" ADD VALUE 'journey_deleted';--> statement-breakpoint
CREATE TABLE "journey_applications" (
	"journey_id" bigint NOT NULL,
	"application_id" bigint NOT NULL,
	CONSTRAINT "journey_applications_journey_id_application_id_pk" PRIMARY KEY("journey_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "journeys" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journeys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journeys_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "journey_applications" ADD CONSTRAINT "journey_applications_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_applications" ADD CONSTRAINT "journey_applications_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journey_applications_application_id_idx" ON "journey_applications" USING btree ("application_id");