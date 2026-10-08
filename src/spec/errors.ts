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
