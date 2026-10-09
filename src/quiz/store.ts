// The understanding quiz (SPEC-A-004 rules 1–3, 5–7). Answering through the gateway is TASK-A-025; this module stores
// what the answering step produces, takes the marks, and says whether the latest quiz passes.
import { and, count, desc, eq, inArray, isNull, like, max } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import type { Gateway } from "../gateway/client";
import { changes, changeSets, projects, quizItems, quizzes } from "../db/schema";
import { AlreadyMarked, NotFound, NotMarkable, QuizClosed, QuizFull, QuizStale, ValidationError } from "../spec/errors";
import { applyChangeSet, loadSpec } from "../spec/store";
import type { Change, Origin } from "../spec/types";
import { answerQuestion } from "./answer";

export const MAX_ANSWERED = 10;
export const MIN_MARKED = 5;
export const MAX_QUESTION_CHARS = 1_000;
export const MAX_NOTE_CHARS = 2_000;

export type QuizItem = {
  id: string; position: number; question: string; status: "answered" | "failed"; answer: string | null;
  notInSpec: boolean; parts: string[]; mark: "right" | "wrong" | null; note: string | null;
  questionKey: string | null; createdAt: string;
};
export type Quiz = {
  id: string; createdAt: string; stale: boolean; items: QuizItem[]; right: number; marked: number; score: number | null;
};
export type NewItem = {
  question: string; status: "answered" | "failed"; answer: string | null; notInSpec: boolean; parts: string[]; model: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type QuizRow = typeof quizzes.$inferSelect;
type ItemRow = typeof quizItems.$inferSelect;

async function lockProject(q: Db, projectId: string) {
  if (!UUID_RE.test(projectId)) throw new NotFound("project");
  const rows = await q.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
  if (rows.length === 0) throw new NotFound("project");
}

async function requireProject(q: Db, projectId: string) {
  if (!UUID_RE.test(projectId)) throw new NotFound("project");
  if ((await q.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).length === 0) throw new NotFound("project");
}

// Rule 1: the newest `created_at`; ties → the larger id. Start times are kept strictly increasing (see startQuiz).
async function latestRow(q: Db, projectId: string): Promise<QuizRow | undefined> {
  const [row] = await q.select().from(quizzes).where(eq(quizzes.projectId, projectId))
    .orderBy(desc(quizzes.createdAt), desc(quizzes.id)).limit(1);
  return row;
}

async function quizRow(q: Db, projectId: string, quizId: string): Promise<QuizRow> {
  if (!UUID_RE.test(quizId)) throw new NotFound("quiz");
  const [row] = await q.select().from(quizzes).where(and(eq(quizzes.id, quizId), eq(quizzes.projectId, projectId)));
  if (!row) throw new NotFound("quiz");
  return row;
}

async function requireLatest(q: Db, projectId: string, quiz: QuizRow) {
  if ((await latestRow(q, projectId))?.id !== quiz.id) throw new QuizClosed();
}

// Rule 2 — no clock: the project's change sets, minus this quiz's own wrong-mark sets, against the count at start.
async function changeSetCount(q: Db, projectId: string, ownQuizId?: string): Promise<number> {
  const where = ownQuizId
    ? and(eq(changeSets.projectId, projectId), like(changeSets.causeRef, `quiz:${ownQuizId}:%`))
    : eq(changeSets.projectId, projectId);
  const [{ n }] = await q.select({ n: count() }).from(changeSets).where(where);
  return n;
}

export async function isStale(q: Db, quiz: QuizRow): Promise<boolean> {
  return (await changeSetCount(q, quiz.projectId)) - (await changeSetCount(q, quiz.projectId, quiz.id)) !== quiz.baseChangeSets;
}

export function scoreOf(items: { mark: string | null }[]) {
  const marked = items.filter((i) => i.mark !== null).length;
  const right = items.filter((i) => i.mark === "right").length;
  // Rule 7: floor, so 99.x never reads 100; under 5 marks there is no score.
  return { right, marked, score: marked >= MIN_MARKED ? Math.floor((right * 100) / marked) : null };
}

async function toQuiz(q: Db, quiz: QuizRow): Promise<Quiz> {
  const rows = await q.select().from(quizItems).where(eq(quizItems.quizId, quiz.id)).orderBy(quizItems.position);
  // The wrong-answer question's key is derived from its change set (the part added there), never stored.
  const setIds = rows.map((r) => r.changeSetId).filter((x): x is string => x !== null);
  const added = setIds.length === 0 ? [] : await q.select({ changeSetId: changes.changeSetId, entity: changes.entity }).from(changes)
    .where(and(inArray(changes.changeSetId, setIds), like(changes.entity, "part:%"), isNull(changes.before)));
  const keyBySet = new Map(added.map((a) => [a.changeSetId!, a.entity.slice("part:".length)]));
  const items = rows.map((r): QuizItem => ({
    id: r.id, position: r.position, question: r.question, status: r.status as QuizItem["status"], answer: r.answer,
    notInSpec: r.notInSpec, parts: r.parts, mark: r.mark as QuizItem["mark"], note: r.note,
    questionKey: r.changeSetId ? keyBySet.get(r.changeSetId) ?? null : null, createdAt: r.createdAt.toISOString(),
  }));
  return { id: quiz.id, createdAt: quiz.createdAt.toISOString(), stale: await isStale(q, quiz), items, ...scoreOf(items) };
}

export async function readQuiz(db: Db, projectId: string, quizId: string): Promise<Quiz> {
  await requireProject(db, projectId);
  return toQuiz(db, await quizRow(db, projectId, quizId));
}

// The latest quiz, or null when the project has none (the confirm gate's question).
export async function latestQuizOrNull(q: Db, projectId: string): Promise<Quiz | null> {
  const row = await latestRow(q, projectId);
  return row ? toQuiz(q, row) : null;
}

export async function latestQuiz(db: Db, projectId: string): Promise<Quiz> {
  await requireProject(db, projectId);
  const quiz = await latestQuizOrNull(db, projectId);
  if (!quiz) throw new NotFound("quiz");
  return quiz;
}

export async function startQuiz(db: Db, projectId: string): Promise<Quiz> {
  const row = await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    // Strictly after the newest quiz: two quizzes started in one millisecond must still have a clear "latest".
    const previous = await latestRow(tx, projectId);
    const createdAt = new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1));
    const [quiz] = await tx.insert(quizzes).values({ projectId, baseChangeSets: await changeSetCount(tx, projectId), createdAt }).returning();
    return quiz!;
  });
  return toQuiz(db, row);
}

const QuestionText = z.string().transform((s) => s.trim())
  .pipe(z.string().min(1).max(MAX_QUESTION_CHARS).refine((s) => !s.includes("\u0000"), "contains a NUL character"));

// Stores one item as the answering step produced it (rule 3: ≤ 10 answered; failed ones do not count).
export async function addItem(db: Db, projectId: string, quizId: string, item: NewItem): Promise<QuizItem> {
  const question = QuestionText.safeParse(item.question);
  if (!question.success) throw new ValidationError(null, `question: 1–${MAX_QUESTION_CHARS} characters, no NUL`);
  const id = await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const quiz = await quizRow(tx, projectId, quizId);
    await requireLatest(tx, projectId, quiz);
    if (await isStale(tx, quiz)) throw new QuizStale();
    if (item.status === "answered") {
      const [{ n }] = await tx.select({ n: count() }).from(quizItems)
        .where(and(eq(quizItems.quizId, quizId), eq(quizItems.status, "answered")));
      if (n >= MAX_ANSWERED) throw new QuizFull();
    }
    const [{ last }] = await tx.select({ last: max(quizItems.position) }).from(quizItems).where(eq(quizItems.quizId, quizId));
    const [row] = await tx.insert(quizItems).values({
      quizId, position: (last ?? 0) + 1, question: question.data, status: item.status, answer: item.answer,
      notInSpec: item.notInSpec, parts: item.parts, model: item.model,
    }).returning();
    return row!.id;
  });
  return itemOf(db, projectId, quizId, id);
}

async function itemOf(db: Db, projectId: string, quizId: string, itemId: string): Promise<QuizItem> {
  const quiz = await toQuiz(db, await quizRow(db, projectId, quizId));
  const item = quiz.items.find((i) => i.id === itemId);
  if (!item) throw new NotFound("quiz item");
  return item;
}

const MarkInput = z.object({
  mark: z.enum(["right", "wrong"]),
  note: z.string().max(MAX_NOTE_CHARS).refine((s) => !s.includes("\u0000"), "contains a NUL character").optional(),
});

// Rule 5 (a mark is final; failed items are not markable) and rule 6 (wrong → an open question, as one change set).
export async function markItem(db: Db, projectId: string, quizId: string, itemId: string,
  input: { mark: "right" | "wrong"; note?: string }, opts: { today: string }): Promise<QuizItem> {
  const parsed = MarkInput.safeParse(input);
  if (!parsed.success) throw new ValidationError(null, `mark: right or wrong; note at most ${MAX_NOTE_CHARS} characters`);
  const { mark, note } = parsed.data;
  await requireProject(db, projectId);
  const quiz = await quizRow(db, projectId, quizId);
  await requireLatest(db, projectId, quiz);
  if (!UUID_RE.test(itemId)) throw new NotFound("quiz item");
  const [item] = await db.select().from(quizItems).where(and(eq(quizItems.id, itemId), eq(quizItems.quizId, quizId)));
  if (!item) throw new NotFound("quiz item");
  if (item.status !== "answered") throw new NotMarkable();
  if (item.mark !== null) throw new AlreadyMarked();

  // Re-checked under the write: a second mark of the same item never lands.
  const setMark = async (tx: Db, changeSetId: string | null) => {
    const [now] = await tx.select({ mark: quizItems.mark }).from(quizItems).where(eq(quizItems.id, itemId));
    if (now?.mark !== null) throw new AlreadyMarked();
    await tx.update(quizItems).set({ mark, note: note ?? null, changeSetId }).where(eq(quizItems.id, itemId));
  };

  if (mark === "right") {
    await db.transaction(async (tx) => { await lockProject(tx, projectId); await setMark(tx, null); });
  } else {
    await applyChangeSet(db, projectId, { cause: { kind: "operator", ref: `quiz:${quizId}:${itemId}` }, changes: wrongToQuestion(item, await liveKeys(db, projectId), opts.today, note) },
      { inTx: async (tx, r) => setMark(tx, r.changeSetId) });
  }
  return itemOf(db, projectId, quizId, itemId);
}

async function liveKeys(db: Db, projectId: string): Promise<Set<string>> {
  return new Set((await loadSpec(db, projectId)).parts.map((p) => p.key));
}

// Rule 6: an open question by the operator (with the user's note), about each part the answer used that still exists.
function wrongToQuestion(item: ItemRow, live: Set<string>, today: string, note: string | undefined): Change[] {
  const origin: Origin = { stamp: "operator", date: today, ...(note ? { note } : {}) };
  return [
    { op: "part.add", ref: "$wrong", kind: "question", title: item.question, body: { text: item.question, status: "open" }, origin },
    ...item.parts.filter((k) => live.has(k)).map((k): Change => ({ op: "link.add", kind: "about", from: "$wrong", to: k, origin })),
  ];
}

// Rule 9: what the version keeps of the quiz that passed the gate.
export function freeze(quiz: Quiz) {
  return {
    id: quiz.id, createdAt: quiz.createdAt,
    items: quiz.items.map(({ position, question, status, answer, notInSpec, parts, mark, note }) =>
      ({ position, question, status, answer, notInSpec, parts, mark, note })),
    right: quiz.right, marked: quiz.marked, score: quiz.score,
  };
}

// The ask path (TASK-A-025): checked before the gateway is called — a closed, stale or full quiz spends no call —
// then answered from the spec and stored (addItem checks again under the lock).
export async function askQuestion(db: Db, gateway: Gateway, projectId: string, quizId: string, question: string): Promise<QuizItem> {
  const text = QuestionText.safeParse(question);
  if (!text.success) throw new ValidationError(null, `question: 1–${MAX_QUESTION_CHARS} characters, no NUL`);
  await requireProject(db, projectId);
  const quiz = await quizRow(db, projectId, quizId);
  await requireLatest(db, projectId, quiz);
  if (await isStale(db, quiz)) throw new QuizStale();
  const [{ n }] = await db.select({ n: count() }).from(quizItems)
    .where(and(eq(quizItems.quizId, quizId), eq(quizItems.status, "answered")));
  if (n >= MAX_ANSWERED) throw new QuizFull();
  const answered = await answerQuestion(db, gateway, projectId, text.data);
  return addItem(db, projectId, quizId, { question: text.data, ...answered });
}
