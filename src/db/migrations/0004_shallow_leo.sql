CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"model" text NOT NULL,
	"creativity" real NOT NULL,
	"round_status" text,
	"change_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"mime" text,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"stored_as" text NOT NULL,
	"text" text,
	"status" text NOT NULL,
	"reason" text,
	"note" text,
	"origin" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_project_sha256_unique" UNIQUE("project_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "model" text DEFAULT 'tier:medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "creativity" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_creativity_range" CHECK ("projects"."creativity" between 0 and 2);