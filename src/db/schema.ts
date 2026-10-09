import { sql } from "drizzle-orm";
import {
  boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, unique, uuid,
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
  model: text("model").notNull().default("tier:medium"),
  creativity: real("creativity").notNull().default(0.5),
}, (t) => [
  check("projects_theme_length", sql`char_length(${t.theme}) between 1 and 64`),
  check("projects_creativity_range", sql`${t.creativity} between 0 and 2`),
]);

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
  // REQ-005: the quiz that passed the confirm gate, frozen with the version (null for versions confirmed before it).
  quiz: jsonb("quiz"),
}, (t) => [primaryKey({ columns: [t.projectId, t.version] })]);

// REQ-003: originals the chatbot reads. `stored_as` is relative to SOURCES_DIR; `origin` says who it is from.
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  mime: text("mime"),
  sha256: text("sha256").notNull(),
  size: integer("size").notNull(),
  storedAs: text("stored_as").notNull(),
  text: text("text"),
  status: text("status").notNull(),
  reason: text("reason"),
  note: text("note"),
  origin: jsonb("origin").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("sources_project_sha256_unique").on(t.projectId, t.sha256)]);

// REQ-003: the chat, one row per user message and per bot reply.
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  model: text("model").notNull(),
  creativity: real("creativity").notNull(),
  roundStatus: text("round_status"),
  changeSetId: uuid("change_set_id").references(() => changeSets.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// REQ-005: the understanding quiz. `base_change_sets` = the project's change sets (none of them this quiz's) at start.
export const quizzes = pgTable("quizzes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  baseChangeSets: integer("base_change_sets").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const quizItems = pgTable("quiz_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  quizId: uuid("quiz_id").notNull().references(() => quizzes.id),
  position: integer("position").notNull(),
  question: text("question").notNull(),
  status: text("status").notNull(),
  answer: text("answer"),
  notInSpec: boolean("not_in_spec").notNull().default(false),
  parts: text("parts").array().notNull().default(sql`'{}'`),
  mark: text("mark"),
  note: text("note"),
  changeSetId: uuid("change_set_id").references(() => changeSets.id),
  model: text("model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("quiz_items_quiz_position_unique").on(t.quizId, t.position)]);
