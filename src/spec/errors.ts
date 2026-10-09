import type { StuckItem } from "./types";

// Store errors. TASK-A-007 maps them to HTTP (400 validation · 404 not_found · 409 undo_conflict).

export class ValidationError extends Error {
  constructor(public readonly index: number | null, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFound extends Error {
  constructor(public readonly what: string) {
    super(`${what} not found`);
    this.name = "NotFound";
  }
}

export class UndoConflict extends Error {
  constructor(public readonly parts: { key: string; title: string }[]) {
    super(`changed again since: ${parts.map((p) => p.key).join(", ")}`);
    this.name = "UndoConflict";
  }
}

export class ConfirmBlocked extends Error {
  constructor(public readonly items: StuckItem[]) {
    super(`cannot confirm: ${items.length} item(s) stuck`);
    this.name = "ConfirmBlocked";
  }
}

export class NothingToConfirm extends Error {
  constructor() {
    super("the project has no live part to confirm");
    this.name = "NothingToConfirm";
  }
}

// D-030 (TASK-A-050): the spec has not changed since its newest confirmed version — confirming it again is refused.
export class AlreadyConfirmed extends Error {
  constructor(public readonly version: number) {
    super(`version ${version} is already confirmed and nothing has changed since`);
    this.name = "AlreadyConfirmed";
  }
}

// REQ-005 (SPEC-A-004): the understanding quiz and the confirm gate. All map to 409 with the code in the name.
export class QuizMissing extends Error {
  constructor() { super("confirm needs an understanding quiz first"); this.name = "QuizMissing"; }
}
export class QuizNot100 extends Error {
  constructor(public readonly right: number, public readonly marked: number) {
    super(`the quiz is not 100 %: ${right} right of ${marked} marked (at least 5 marked, all right)`);
    this.name = "QuizNot100";
  }
}
export class QuizStale extends Error {
  constructor() { super("the spec changed after the quiz started — start a new quiz"); this.name = "QuizStale"; }
}
export class QuizClosed extends Error {
  constructor() { super("only the latest quiz takes questions and marks"); this.name = "QuizClosed"; }
}
export class QuizFull extends Error {
  constructor() { super("a quiz holds at most 10 answered questions"); this.name = "QuizFull"; }
}
export class AlreadyMarked extends Error {
  constructor() { super("this answer is already marked — a mark is final"); this.name = "AlreadyMarked"; }
}
export class NotMarkable extends Error {
  constructor() { super("a question the bot could not answer cannot be marked"); this.name = "NotMarkable"; }
}
