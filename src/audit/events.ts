// REQ-103 / SPEC-104 D5: one `audit_events` row for a write that is not a spec change (spec changes keep their home in
// `change_sets`/`changes`). Always called with the same `tx` as the change it records, so the two land together or not at all.
import type { Db } from "../db/client";
import { auditEvents } from "../db/schema";
import type { Tx } from "../spec/store";

export type AuditAction =
  | "project_create" | "settings" | "source_add" | "source_refetch" | "label" | "quiz_start" | "quiz_ask" | "quiz_mark";

export async function recordAudit(q: Db | Tx, e: {
  projectId: string; by: string; action: AuditAction; entity: string; before?: unknown; after?: unknown;
}): Promise<void> {
  await q.insert(auditEvents).values({
    projectId: e.projectId, by: e.by, action: e.action, entity: e.entity, before: e.before ?? null, after: e.after ?? null,
  });
}
