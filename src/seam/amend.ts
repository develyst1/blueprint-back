// SPEC-A-005 § S2.4: a change request from a CAW worker lands in the chat as one `caw` message. The spec is not
// touched — no change set, no part (AC-5); the next interview round reads it and the bot asks about it.
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { messages, parts, projects } from "../db/schema";
import { ValidationError } from "../spec/errors";
import { requireProject } from "./feed";

export const MAX_FROM_CHARS = 100;
export const MAX_REQUEST_CHARS = 4_000;
export const MAX_ABOUT = 20;

const noNul = (s: string) => !s.includes("\u0000");
export const Amendment = z.object({
  from: z.string().min(1).max(MAX_FROM_CHARS).refine(noNul, "from contains a NUL character"),
  request: z.string().min(1).max(MAX_REQUEST_CHARS).refine(noNul, "request contains a NUL character"),
  about: z.array(z.string()).max(MAX_ABOUT).optional(),
});
export type Amendment = z.infer<typeof Amendment>;

export type CawMessage = {
  id: string; role: "caw"; content: string; model: string; creativity: number;
  roundStatus: null; changeSetId: null; createdAt: string;
};

// The header carries who sent it and what it is about; the interview context passes it on as is.
const content = (a: Amendment) => `[CAW ${a.from}]${a.about?.length ? ` about: ${a.about.join(", ")}` : ""}\n${a.request}`;

export async function addAmendment(db: Db, projectId: string, input: unknown): Promise<CawMessage> {
  await requireProject(db, projectId);
  const parsed = Amendment.safeParse(input);
  if (!parsed.success) throw new ValidationError(null, z.prettifyError(parsed.error));
  const a = parsed.data;
  return db.transaction(async (tx) => {
    // Same project lock as rounds and change sets: the `about` keys cannot be removed under us, and times stay ordered.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
    if (a.about?.length) {
      const live = new Set((await tx.select({ key: parts.key, removedAt: parts.removedAt }).from(parts)
        .where(eq(parts.projectId, projectId))).filter((p) => p.removedAt === null).map((p) => p.key));
      const unknown = a.about.filter((k) => !live.has(k));
      if (unknown.length) throw new ValidationError(null, `about: not a live part of this project: ${unknown.join(", ")}`);
    }
    // Strictly after the newest message, like every other chat row (equal times were seen; order must be total).
    const [latest] = await tx.select({ at: messages.createdAt }).from(messages)
      .where(eq(messages.projectId, projectId)).orderBy(desc(messages.createdAt)).limit(1);
    const createdAt = new Date(Math.max(Date.now(), (latest?.at.getTime() ?? 0) + 1));
    const [row] = await tx.insert(messages).values({
      projectId, role: "caw", content: content(a), model: "caw", creativity: 0, createdAt,
    }).returning();
    return { id: row!.id, role: "caw", content: row!.content, model: row!.model, creativity: row!.creativity,
      roundStatus: null, changeSetId: null, createdAt: row!.createdAt.toISOString() };
  });
}
