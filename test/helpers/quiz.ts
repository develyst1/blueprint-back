// A quiz that passes the confirm gate (REQ-005 R6): started now, 5 answered items, all marked right.
// Call it after the last spec change you want confirmed — any later change set makes the quiz stale.
import type { Db } from "../../src/db/client";
import { addItem, markItem, startQuiz } from "../../src/quiz/store";

export async function passingQuiz(db: Db, projectId: string) {
  const quiz = await startQuiz(db, projectId);
  for (let i = 1; i <= 5; i++) {
    const item = await addItem(db, projectId, quiz.id, {
      question: `คำถามทดสอบข้อ ${i}`, status: "answered", answer: `คำตอบ ${i}`, notInSpec: false, parts: [], model: "openai/gpt-4.1-mini",
    });
    await markItem(db, projectId, quiz.id, item.id, { mark: "right" }, { today: "2026-10-09" });
  }
  return quiz;
}
