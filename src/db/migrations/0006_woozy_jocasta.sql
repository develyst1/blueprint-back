CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"by" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
ALTER TABLE "versions" ALTER COLUMN "last_change_set" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "change_sets" ADD COLUMN "by" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "by" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_project_at_idx" ON "audit_events" USING btree ("project_id","at");