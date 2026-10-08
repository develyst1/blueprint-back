import { sql } from "drizzle-orm";
import {
  check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid,
} from "drizzle-orm/pg-core";

export const DEFAULT_ORGANISATION_ID = "00000000-0000-0000-0000-000000000001";

// The default organisation row is inserted by the custom migration `db_rules`.
export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organisationId: uuid("organisation_id").notNull().default(DEFAULT_ORGANISATION_ID)
    .references(() => organisations.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  theme: text("theme").notNull().default("clean-blue"),
}, (t) => [check("projects_theme_length", sql`char_length(${t.theme}) between 1 and 64`)]);

export const parts = pgTable("parts", {
  projectId: uuid("project_id").references(() => projects.id),
  key: text("key"),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: jsonb("body").notNull().default({}),
  origin: jsonb("origin").notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.projectId, t.key] })]);

export const links = pgTable("links", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull(),
  kind: text("kind").notNull(),
  fromKey: text("from_key").notNull(),
  toKey: text("to_key").notNull(),
  position: integer("position"),
  label: text("label"),
  origin: jsonb("origin").notNull(),
}, (t) => [
  foreignKey({ columns: [t.projectId, t.fromKey], foreignColumns: [parts.projectId, parts.key] }),
  foreignKey({ columns: [t.projectId, t.toKey], foreignColumns: [parts.projectId, parts.key] }),
  index("links_project_from_idx").on(t.projectId, t.fromKey),
  index("links_project_to_idx").on(t.projectId, t.toKey),
]);

export const changeSets = pgTable("change_sets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  causeKind: text("cause_kind").notNull(),
  causeRef: text("cause_ref"),
  undoes: uuid("undoes").references((): any => changeSets.id),
});

export const changes = pgTable("changes", {
  changeSetId: uuid("change_set_id").references(() => changeSets.id),
  seq: integer("seq"),
  entity: text("entity").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
}, (t) => [
  primaryKey({ columns: [t.changeSetId, t.seq] }),
  index("changes_entity_idx").on(t.entity),
]);

export const versions = pgTable("versions", {
  projectId: uuid("project_id").references(() => projects.id),
  version: integer("version"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedBy: text("confirmed_by").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  summary: jsonb("summary").notNull(),
  lastChangeSet: uuid("last_change_set").notNull().references(() => changeSets.id),
}, (t) => [primaryKey({ columns: [t.projectId, t.version] })]);
