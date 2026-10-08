CREATE TABLE "change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"cause_kind" text NOT NULL,
	"cause_ref" text,
	"undoes" uuid
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"change_set_id" uuid,
	"seq" integer,
	"entity" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	CONSTRAINT "changes_change_set_id_seq_pk" PRIMARY KEY("change_set_id","seq")
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_key" text NOT NULL,
	"to_key" text NOT NULL,
	"position" integer,
	"label" text,
	"origin" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parts" (
	"project_id" uuid,
	"key" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin" jsonb NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "parts_project_id_key_pk" PRIMARY KEY("project_id","key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"project_id" uuid,
	"version" integer,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"last_change_set" uuid NOT NULL,
	CONSTRAINT "versions_project_id_version_pk" PRIMARY KEY("project_id","version")
);
--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_undoes_change_sets_id_fk" FOREIGN KEY ("undoes") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_project_id_from_key_parts_project_id_key_fk" FOREIGN KEY ("project_id","from_key") REFERENCES "public"."parts"("project_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_project_id_to_key_parts_project_id_key_fk" FOREIGN KEY ("project_id","to_key") REFERENCES "public"."parts"("project_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_last_change_set_change_sets_id_fk" FOREIGN KEY ("last_change_set") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "changes_entity_idx" ON "changes" USING btree ("entity");--> statement-breakpoint
CREATE INDEX "links_project_from_idx" ON "links" USING btree ("project_id","from_key");--> statement-breakpoint
CREATE INDEX "links_project_to_idx" ON "links" USING btree ("project_id","to_key");