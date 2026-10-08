# Blueprint Back — Foundation Implementation Plan (Plan 1 of 4)

> ⚠️ **SUPERSEDED (Atlas, 2026-10-09).** The desk built REQ-001 from its own `SPEC-A-001` and `TASK-A-001…007`
> after the operator ruled galaxy-spec a failed example (desk `DECISIONS.md` 2026-10-08). This plan's galaxy-spec
> parity exam and importer (Tasks 5–6) are void; the rest is history. Do not execute this file.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running `blueprint-back` that stores a project's spec graph in Postgres, records every change as an undoable event, checks the graph with galaxy-spec's rules (proven equal to `check.mjs`), imports a galaxy-spec `spec.json`, locks confirmed versions, and serves all of it over a typed HTTP API with a generated OpenAPI document.

**Architecture:** Hono app on Bun (`@hono/zod-openapi`, so every route's schema is also the OpenAPI document). Drizzle ORM over Postgres; tests run the same migrations on PGlite (Postgres compiled to WASM — real engine, nothing to install). The checker is a set of pure functions over an in-memory `SpecGraph`; storage, checker and HTTP never import each other's internals.

**Tech Stack:** Bun 1.4.2 · hono 4.13.13 · @hono/zod-openapi 1.6.3 · zod 4.6.5 · drizzle-orm 0.45.4 · drizzle-kit 0.31.11 · postgres 3.4.9 · @electric-sql/pglite 0.5.8 · `bun test`

**Spec:** `../docs/specs/2026-10-08-blueprint-design.md` (relative to the repo root; the folder `~/Develyst/intelligence-space/docs/`). Read §2, §4, §7, §9, §10 before starting.

**The four plans:** 1 (this) foundation · 2 sources + Gateway client + interview loop + semantic contradiction check · 3 seam API v1 for CAW · 4 `blueprint-front` (starts only after the operator says "yes" to one mockup per theme — spec §6), including the one v1 export: **PDF** of the spec.

## Global Constraints

- **No git writes by any AI — not a branch, not a commit, not a push.** Git is the operator's alone; he commits when he deploys or when he chooses (`[operator 2026-10-08]` *"ไม่ต้องยุ่งกับ git เด็ดขาด"*). Every "Commit" step below is **void**: end each task at "files written, tests run". Reading git state (`git status`, `git diff`) is fine and is how a reviewer sees a task's change.

- Exact dependency versions as in Tech Stack — no `^` / `~` in `package.json`.
- Hono holds all logic; nothing in `blueprint-front` will ever reach the database.
- All routes live under `/v1`. The OpenAPI document is served at `GET /v1/openapi.json` and written to `openapi.json` at the repo root by `bun run openapi:emit`.
- Node id regex, verbatim: `^(WF|UC|JE|SCR|MJ|ST|API|TC|DIA|DOC)-\d{3,}$`. Ids are permanent: never renumbered, never reused.
- Provenance kinds, verbatim: `operator`, `operator-delegated`, `team-proposed`, `customer-asked`, `customer-validated`, `legacy-observed`.
- Checker messages are the Thai strings of `mychannel-mc2-spec/spec/check.mjs`, copied verbatim (they are the parity oracle).
- Derived values (findings, counts, readiness) are computed on read, never stored. Only a confirmed version freezes its checker result.
- Rows of `spec_versions` cannot be updated or deleted — enforced by a database trigger, not by code.
- Config from env only: `DATABASE_URL` (`pglite:memory` allowed), `PORT` (default `4200`). Committed: `.env.example`, never `.env`.
- Client data is never committed: the mc2 `spec.json` is read from `MC2_SPEC_PATH` at test time; the parity test skips (and says so) when it is unset.

## Review Focus

1. **Import with duplicate node ids** — cannot be stored under a primary key; expect the whole import rejected with HTTP 422 listing every duplicate id, and nothing written. → Task 6.
2. **Undo after a later edit to the same node** — expect HTTP 409 naming the node, and no change; never silently overwrite newer work. → Task 4.
3. **Deleting a node that has edges** — expect its edges removed in the same batch (and restored by undo), never dangling edges. → Task 4.
4. **Confirm while the checker has FAILs** — expect HTTP 409 with the findings, no version row. → Task 7.
5. **Thai text and id ordering** — Thai titles round-trip byte-identical; lists sort `UC-009` before `UC-010` (numeric, not lexical). → Task 4.

---

## File Structure

```
blueprint-back/
  package.json · tsconfig.json · drizzle.config.ts · .env.example · openapi.json (generated)
  src/
    index.ts                 # Bun.serve entry — reads env, builds app
    app.ts                   # createApp(db): OpenAPIHono — mounts routes, /health, /v1/openapi.json
    db/schema.ts             # Drizzle tables
    db/client.ts             # createDb(url): Db
    db/migrations/           # drizzle-kit output + 0001_versions_immutable.sql
    spec/types.ts            # zod schemas + TS types for the graph (the contract)
    spec/ids.ts              # compareIds, idType
    spec/graph.ts            # loadGraph, applyChanges, undoBatch
    checker/index.ts         # check(graph): CheckResult
    checker/rules/identity.ts · provenance.ts · odyssey.ts · reachability.ts · flows.ts · coverage.ts · figma.ts · openapi.ts
    import/galaxy.ts         # graphFromGalaxyJson (pure) · importGalaxySpec (db)
    projects/service.ts      # createProject, listProjects, confirmVersion, getVersion
    http/routes/*.ts         # one file per resource
    scripts/emit-openapi.ts
  test/
    helpers/db.ts            # testDb(): fresh PGlite with migrations applied
    fixtures/synthetic-spec.json   # committed; trips every rule
    reference/check.mjs      # verbatim copy of mychannel-mc2-spec/spec/check.mjs (the oracle)
    …*.test.ts mirrors src/
```

---

### Task 1: Scaffold and health route

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`, `src/app.ts`, `src/index.ts`
- Test: `test/app.test.ts`

**Interfaces:**
- Produces: `createApp(db: Db): OpenAPIHono` in `src/app.ts` (Task 2 defines `Db`; here accept `unknown` and tighten in Task 2).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createApp } from "../src/app";
test("GET /health answers ok", async () => {
  const res = await createApp(undefined as any).request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, service: "blueprint-back" });
});
```

- [ ] **Step 2: Run** `bun test test/app.test.ts` — Expected: FAIL, cannot find module `../src/app`.
- [ ] **Step 3: Implement** `package.json` (scripts: `dev`, `test`, `db:generate` = `drizzle-kit generate`, `openapi:emit`), exact deps from Tech Stack, `tsconfig.json` (strict, `moduleResolution: bundler`, `types: ["bun-types"]`), `createApp` returning an `OpenAPIHono` with `/health`, `src/index.ts` calling `Bun.serve({ port: Number(process.env.PORT ?? 4200), fetch: app.fetch })`, `.env.example` with `DATABASE_URL=` and `PORT=4200` (each with a one-line comment saying what goes there), and a local **`.env`** copied from it with the values left empty — the operator fills it in (`[operator 2026-10-08]` "ทำ env เดี๋ยวไปใส่"); `.env` is already in `.gitignore:81`, never commit it.
- [ ] **Step 4: Run** `bun test` — Expected: 1 pass.
- [ ] **Step 5: Commit** `git add -A && git commit -m "chore: scaffold blueprint-back with health route"`

---

### Task 2: Database schema, client, migrations, immutable versions

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`, `src/db/migrations/*` (generated), `src/db/migrations/0001_versions_immutable.sql`, `test/helpers/db.ts`
- Test: `test/db/versions-immutable.test.ts`

**Interfaces:**
- Produces: `type Db` (Drizzle instance, either driver) · `createDb(url: string): Promise<Db>` — `pglite:memory` → PGlite, otherwise `postgres` · `testDb(): Promise<Db>` — fresh PGlite with every migration applied · tables below · `type Project = typeof projects.$inferSelect`.
- Deferred to Plan 2 by design (no task here needs them): `sources`, `messages`. The spec's project status `drafting → ready → building` is derived — `ready` = has a confirmed version, `building` = handed to CAW (Plan 3) — so it is not a column.

Tables (column names are the contract later tasks use):

| table | columns |
|---|---|
| `projects` | `id uuid pk default gen_random_uuid()`, `name text not null`, `theme text not null default 'clean-blue'`, `model text`, `creativity real not null default 0.5`, `profile text`, `settings jsonb not null default '{}'` (holds `{ requireFigma?: boolean }` — the checker's Figma policy), `created_at timestamptz default now()` |
| `spec_nodes` | `project_id uuid fk`, `id text`, `type text`, `title text`, `status text`, `prov jsonb not null`, `updated text`, `body jsonb not null default '{}'`, pk `(project_id, id)` |
| `spec_edges` | `project_id`, `from_id text`, `to_id text`, pk `(project_id, from_id, to_id)` |
| `spec_flows` | `project_id`, `id text`, `uc text`, `title text`, `steps jsonb not null`, `extra jsonb not null default '{}'`, pk `(project_id, id)` |
| `decisions` | `project_id`, `id text`, `text text not null`, `scope text`, `prov jsonb`, pk `(project_id, id)` |
| `questions` | `project_id`, `id text`, `node_id text`, `text text not null`, `proposed_answer text`, `status text not null default 'open'`, `answer text`, pk `(project_id, id)` |
| `spec_events` | `seq bigserial pk`, `project_id`, `batch_id uuid not null`, `at timestamptz default now()`, `cause jsonb not null`, `entity text not null`, `entity_key text not null`, `before jsonb`, `after jsonb` |
| `spec_versions` | `project_id`, `version int`, `confirmed_at timestamptz default now()`, `confirmed_by text not null`, `snapshot jsonb not null`, `check_result jsonb not null`, pk `(project_id, version)` |

Project `status` is **not** a column: `ready`/`building` is derived from versions (Global Constraints — never store derived).

- [ ] **Step 1: Write the failing test**

```ts
test("a confirmed version cannot be updated or deleted", async () => {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "x" }).returning();
  await db.insert(specVersions).values({ projectId: p.id, version: 1, confirmedBy: "operator", snapshot: {}, checkResult: {} });
  await expect(db.update(specVersions).set({ confirmedBy: "someone" })).rejects.toThrow(/immutable/);
  await expect(db.delete(specVersions)).rejects.toThrow(/immutable/);
});
```

- [ ] **Step 2: Run** `bun test test/db` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the schema, `bun run db:generate`, then hand-write `0001_versions_immutable.sql`: a `plpgsql` function raising `'spec_versions rows are immutable'` and a `BEFORE UPDATE OR DELETE` trigger on `spec_versions`. `testDb()` uses `drizzle-orm/pglite/migrator`.
- [ ] **Step 4: Run** `bun test` — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "feat(db): schema, migrations, immutable spec_versions"` (add new files first).

---

### Task 3: Graph contract types and id ordering

**Files:**
- Create: `src/spec/types.ts`, `src/spec/ids.ts`
- Test: `test/spec/types.test.ts`, `test/spec/ids.test.ts`

**Interfaces:**
- Produces (zod schemas + inferred types, all exported):
  `ProvKind` (the six kinds) · `Prov { kind; date?; channel?; note?; by?; source?: { repo: string; path: string; line?: number } }` (lenient on missing fields — the checker, not the parser, reports them) ·
  `SpecNode { id: string; type: string; title?: string; status?: string; prov?: Prov; updated?: string; body: Record<string, unknown> }` ·
  `Edge = [string, string]` · `FlowStep { scr: string; on?: string; branches?: { when?: string; to: string; note?: string }[] }` ·
  `Flow { id: string; uc?: string; title?: string; steps: FlowStep[]; extra: Record<string, unknown> }` ·
  `Decision { id; text; scope?; prov? }` · `Question { id; nodeId?; text; proposedAnswer?; status: "open"|"answered"|"parked"; answer? }` ·
  `SpecGraph { profile?: string; designPolicyRequireFigma?: boolean; storesDesignScreens?: boolean; nodes: SpecNode[]; edges: Edge[]; flows: Flow[]; decisions: Decision[]; questions: Question[] }` ·
  `ID_RE` (verbatim regex) · `compareIds(a: string, b: string): number` · `idType(id: string): string`.
- `storesDesignScreens` exists only so the checker can report galaxy-spec's "design.screens stored" rule on imported files; Blueprint itself never stores it.

- [ ] **Step 1: Write failing tests** — `compareIds` sorts `["UC-010","UC-009","API-002","UC-001"]` → `["API-002","UC-001","UC-009","UC-010"]` (type alphabetical, then numeric); `idType("SCR-004") === "SCR"`; `SpecNode.parse` keeps a Thai title byte-identical; `ProvKind.safeParse("owner").success === false`.
- [ ] **Step 2: Run** `bun test test/spec` — Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(spec): graph contract types and id ordering`

---

### Task 4: Graph store — load, apply changes as events, undo

**Files:**
- Create: `src/spec/graph.ts`
- Test: `test/spec/graph.test.ts`

**Interfaces:**
- Consumes: `Db`, tables (Task 2); types (Task 3).
- Produces:
  - `type Change = { op: "node.upsert"; node: SpecNode } | { op: "node.delete"; id: string } | { op: "edge.add"; edge: Edge } | { op: "edge.remove"; edge: Edge } | { op: "flow.upsert"; flow: Flow } | { op: "decision.upsert"; decision: Decision } | { op: "question.upsert"; question: Question }`
  - `type Cause = { kind: "operator" | "message" | "source" | "import"; ref?: string }`
  - `loadGraph(db: Db, projectId: string): Promise<SpecGraph>` — nodes sorted by `compareIds`; `profile` from `projects.profile`; `designPolicyRequireFigma` from `projects.settings.requireFigma`; `storesDesignScreens` is always `false` (Blueprint never stores it).
  - `applyChanges(db: Db, projectId: string, changes: Change[], cause: Cause): Promise<{ batchId: string }>` — one transaction; one `spec_events` row per touched entity with `before`/`after`; `node.delete` also deletes and records every edge touching the node.
  - `undoBatch(db: Db, projectId: string, batchId: string): Promise<{ batchId: string }>` — applies the inverse as a new batch with cause `{ kind: "operator", ref: "undo:<batchId>" }`; throws `UndoConflict { entityKeys: string[] }` if any entity's current value differs from that batch's `after`.

- [ ] **Step 1: Write failing tests**
  - upsert 2 nodes + 1 edge → `loadGraph` returns them; 3 events share one `batchId`.
  - a change list whose 2nd item is invalid (edge to a node id failing `ID_RE`) writes nothing (transaction).
  - Review Focus 3: delete `SCR-001` that has edges `UC-001→SCR-001`, `SCR-001→API-001` → both edges gone; `undoBatch` restores node and both edges.
  - Review Focus 2: batch A upserts `UC-001` title "ก"; batch B sets title "ข"; `undoBatch(A)` throws `UndoConflict` with `entityKeys` `["node:UC-001"]`; title still "ข".
  - Review Focus 5: title `"เปลี่ยนแพ็กเกจหลัก / แพ็กเกจเสริม"` round-trips identical; nodes `UC-010`, `UC-009` load as `UC-009`, `UC-010`.
- [ ] **Step 2: Run** `bun test test/spec/graph.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/spec/graph.ts`. Entity keys: `node:<id>`, `edge:<from>><to>`, `flow:<id>`, `decision:<id>`, `question:<id>`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(spec): event-sourced graph store with undo`

---

### Task 5: Checker — galaxy-spec rules, parity with `check.mjs`

**Files:**
- Create: `src/checker/index.ts`, `src/checker/rules/{identity,provenance,odyssey,reachability,flows,coverage,figma,openapi}.ts`, `test/reference/check.mjs` (verbatim copy of `mychannel-mc2-spec/spec/check.mjs`), `test/fixtures/synthetic-spec.json`
- Test: `test/checker/rules.test.ts` (the parity test is written in Task 6, which provides `graphFromGalaxyJson` — no red test is committed here)

**Interfaces:**
- Consumes: `SpecGraph` (Task 3).
- Produces: `type Finding = { level: "fail" | "warn"; rule: string; nodeId?: string; message: string }` · `type CheckResult = { fails: Finding[]; warns: Finding[] }` · `check(graph: SpecGraph): CheckResult` · `formatFinding(f: Finding): string` → `"FAIL  <message>"` / `"WARN  <message>"` (two spaces, as the reference prints).
- Each `rules/*.ts` exports one `(g: SpecGraph) => Finding[]`, ported from the matching section of the reference (identity §1 · provenance §2/2b · odyssey §2c (only when `profile === "odyssey"`) · design.screens · reachability §3 · flows · coverage §4 · figma §5). `openapi.ts` ports only the file-free part of §6: `ยังไม่ผูก operationId ใน OpenAPI` warn. The file-reading part of §6 is out of scope (spec §10).
- Messages are copied verbatim, including the node id prefix the reference prints (`${n.id}: …`).

- [ ] **Step 1: Write the synthetic fixture** `test/fixtures/synthetic-spec.json` in galaxy-spec format with `project.profile: "odyssey"` and at least one node or flow that trips **every** FAIL and WARN message in the reference except §6's file-reading ones (duplicate id, bad id, type/prefix mismatch, edge to missing node, duplicate edge, missing prov, bad prov kind, missing prov date, customer-validated without channel, Delivered not customer-validated, operator-delegated without note, legacy-observed without source, every odyssey JE/MJ/ST/SCR rule, `design.screens`, unreachable node, flow without steps / to missing / non-SCR / branch without `when` / branch to missing / repeated screen / `start` field / single step, UC without flow / SCR / TC / API, every Figma case, API without operationId). No client data — invented names only.
- [ ] **Step 2: (moved to Task 6, Step 0)** — the parity test below is written there; it is kept here so the checker author sees the oracle. For each case in `[synthetic fixture, MC2_SPEC_PATH if set]`: copy `test/reference/check.mjs` and the `spec.json` into a temp dir as `spec/check.mjs` + `spec/spec.json`, run `node spec/check.mjs`, collect lines starting `FAIL  ` / `WARN  `; compute Blueprint's lines with `check(graphFromGalaxyJson(json)).{fails,warns}.map(formatFinding)` (Task 6 provides `graphFromGalaxyJson`); drop from **both** sides lines matching `/openapi\.file|บนเครื่องนี้ไม่เจอ|present:false|เป็น JSON ไม่ได้|ไม่มีใน .*\/.* — สัญญา API/` (the out-of-scope §6 file checks); assert the two **sorted** arrays are equal. When `MC2_SPEC_PATH` is unset, `test.skip` with the reason in its name. Also assert the synthetic fixture yields ≥ 1 line per rule file (no rule silently dead).
- [ ] **Step 3: Write unit tests** in `rules.test.ts` — one small graph per rule file asserting the exact message.
- [ ] **Step 4: Run** `bun test test/checker` — Expected: FAIL.
- [ ] **Step 5: Implement** the rules and `check`. Sort output `fails` then `warns`, each by node id via `compareIds`.
- [ ] **Step 6: Run** `bun test test/checker/rules.test.ts` — Expected: PASS.
- [ ] **Step 7: Commit** `feat(checker): port galaxy-spec rules`

---

### Task 6: galaxy-spec importer

**Files:**
- Create: `src/import/galaxy.ts`
- Test: `test/import/galaxy.test.ts`

**Interfaces:**
- Consumes: `applyChanges` (Task 4), `check` (Task 5), types (Task 3).
- Produces:
  - `graphFromGalaxyJson(json: unknown): SpecGraph` — pure. Node fields `id, type, title, status, prov, updated` map to columns; **every other field** (`spec`, `figma`, `openapi`, `desc`, `estimate`, `acceptance`, `contract`, `apiless`, …) goes into `body` unchanged; node `questions: string[]` → `Question` rows `Q-<nodeId>-<n>` (`status: "open"`); `project.decisions[]` → `Decision` rows; `project.profile`, `design.policy.requireFigma`, presence of `design.screens` → the graph flags. Figma rule reads `body.figma`; coverage/openapi read `body.apiless` / `body.openapi`.
  - `importGalaxySpec(db: Db, projectId: string, json: unknown): Promise<{ batchId: string; counts: { nodes: number; edges: number; flows: number; decisions: number; questions: number } }>` — throws `ImportRejected { duplicateIds: string[] }` before writing anything if ids repeat; otherwise one `applyChanges` batch with cause `{ kind: "import", ref: "galaxy-spec" }`; sets `projects.profile` and `projects.settings.requireFigma` (from `design.policy.requireFigma`).
- Duplicate ids are a reference FAIL that Blueprint cannot store; for parity, `graphFromGalaxyJson` keeps duplicates (pure, in memory) and only `importGalaxySpec` rejects.

- [ ] **Step 0: Write `test/checker/parity.test.ts`** exactly as described in Task 5 Step 2.
- [ ] **Step 1: Write failing tests**
  - synthetic fixture with its duplicate removed → import → `check(await loadGraph(...))` equals `check(graphFromGalaxyJson(json))` **minus the `design.screens` finding** (Blueprint never stores `design.screens`, so the import removes that defect by construction); `requireFigma` survives via `projects.settings` (round-trip loses nothing else a rule reads).
  - Review Focus 1: fixture with duplicates → `ImportRejected` listing every duplicate id; `loadGraph` returns an empty graph.
  - counts match the input.
- [ ] **Step 2: Run** `bun test test/import` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — Expected: all pass, **including `parity.test.ts`**. Then run once with `MC2_SPEC_PATH=/Users/entronica/Work/mychannel-mc2-spec/spec/spec.json bun test test/checker/parity.test.ts` — Expected: PASS with 0 FAIL and 18 WARN lines on both sides (baseline 2026-10-08). Paste the output into the task report.
- [ ] **Step 5: Commit** `feat(import): galaxy-spec importer; checker parity green`

---

### Task 7: Projects and versions service

**Files:**
- Create: `src/projects/service.ts`
- Test: `test/projects/service.test.ts`

**Interfaces:**
- Consumes: `loadGraph` (4), `check` (5).
- Produces:
  - `createProject(db, input: { name: string; theme?: string; model?: string; creativity?: number }): Promise<Project>` — `creativity` must be within `0..2` (the gateway's temperature range).
  - `listProjects(db): Promise<(Project & { readiness: { fails: number; warns: number; openQuestions: number }; latestVersion: number | null })[]>` — readiness computed live.
  - `confirmVersion(db, projectId, by: string): Promise<{ version: number }>` — throws `ConfirmBlocked { findings: Finding[]; openQuestions: Question[] }` when `check` has any fail **or** any question has `status === "open"` (spec §7); otherwise inserts `version = max + 1` with `snapshot` = the full `SpecGraph` and `check_result` = the `CheckResult`.
  - `getVersion(db, projectId, version: number): Promise<{ version; confirmedAt; confirmedBy; graph: SpecGraph; checkResult: CheckResult } | null>`

- [ ] **Step 1: Write failing tests** — Review Focus 4 (a fail → `ConfirmBlocked`, no row); an open question → `ConfirmBlocked`; clean graph → v1 then v2; `getVersion(1)` unchanged after editing the live graph; `listProjects` readiness reflects a just-added failing node without any recompute call.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(projects): projects and locked versions`

---

### Task 8: HTTP API v1 and the OpenAPI document

**Files:**
- Create: `src/http/routes/{projects,graph,changes,versions,import}.ts`, `src/scripts/emit-openapi.ts`; Modify: `src/app.ts`, `src/index.ts`
- Test: `test/http/api.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7. `createApp(db: Db)` now takes the real `Db`.
- Produces (all JSON, schemas from `src/spec/types.ts`):

| Route | Success | Errors |
|---|---|---|
| `POST /v1/projects` | 201 project | 400 validation |
| `GET /v1/projects` | 200 list with readiness | — |
| `GET /v1/projects/{id}/graph` | 200 `SpecGraph` | 404 |
| `GET /v1/projects/{id}/findings` | 200 `CheckResult` | 404 |
| `POST /v1/projects/{id}/changes` body `{ changes: Change[], cause: Cause }` | 200 `{ batchId }` | 400 · 404 |
| `POST /v1/projects/{id}/batches/{batchId}/undo` | 200 `{ batchId }` | 409 `{ entityKeys }` |
| `POST /v1/projects/{id}/import/galaxy` body = galaxy `spec.json` | 200 `{ batchId, counts }` | 422 `{ duplicateIds }` |
| `POST /v1/projects/{id}/versions` body `{ by: string }` | 201 `{ version }` | 409 `{ findings, openQuestions }` |
| `GET /v1/projects/{id}/versions/{v}` | 200 | 404 |
| `GET /v1/openapi.json` | 200 OpenAPI 3.1 | — |

- Error body shape everywhere: `{ error: { code: string; message: string; details?: unknown } }`. Codes: `validation` (400) · `not_found` (404) · `undo_conflict` (409, `details.entityKeys`) · `confirm_blocked` (409, `details.findings`, `details.openQuestions`) · `import_rejected` (422, `details.duplicateIds`).

- [ ] **Step 1: Write failing tests** with `createApp(await testDb()).request(...)`, one test per flow:
  - project A: import the synthetic fixture minus its duplicate → `findings.fails.length > 0` → confirm → 409 with `findings`.
  - project B: `POST changes` with one node `{ id: "WF-001", type: "WF", title: "งานหลัก", prov: { kind: "operator", date: "2026-10-08" }, body: {} }` → confirm `{ by: "operator" }` → 201 `{ version: 1 }` → `GET versions/1` → 200 with that node.
  - project B: undo a batch after a later edit to the same node → 409 `{ error: { code: "undo_conflict", details: { entityKeys: ["node:WF-001"] } } }`.
  - import with duplicate ids → 422 `{ error: { code: "import_rejected", details: { duplicateIds } } }`.
  - `GET /v1/openapi.json` contains every path in the table.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** routes with `createRoute` + `app.openapi`; `emit-openapi.ts` writes `openapi.json` (pretty, stable key order). **Step 4: Run** `bun test` — Expected: all pass. Then `bun run openapi:emit && git diff --stat openapi.json` — Expected: file created.
- [ ] **Step 5: Smoke** `DATABASE_URL=pglite:memory bun run dev` then `curl -s localhost:4200/health` → `{"ok":true,"service":"blueprint-back"}`.
- [ ] **Step 6: Commit** `feat(http): v1 API and generated OpenAPI document`

---

## Done means

`bun test` green (paste the summary line) · the mc2 parity run green with 18/18 WARN lines (paste) · `openapi.json` committed · `curl /health` answers. Plans 2–4 build on exactly these interfaces.
