ALTER TABLE "change_sets" ADD COLUMN "rev" integer;--> statement-breakpoint
-- HAND-WRITTEN backfill (SPEC-106 § Data Model, TASK-113): existing change sets are numbered 1, 2, 3 … per project, by time.
UPDATE "change_sets" c SET "rev" = r."n" FROM (
  SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "at", "id") AS "n" FROM "change_sets"
) r WHERE r."id" = c."id";--> statement-breakpoint
ALTER TABLE "change_sets" ALTER COLUMN "rev" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "change_sets_project_rev_idx" ON "change_sets" USING btree ("project_id","rev");
