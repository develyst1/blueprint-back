// SPEC-112 G1/G4 (REQ-115): which model a gateway call asks for, by the weight of the task, and the record kept of each call.
// `heavy` keeps the project's model; `light` is the cheap one. The setting is read at call time, so a changed `.env` applies on
// the next call after a restart and needs no code change.
import { modelRequest } from "./client";

export type Weight = "heavy" | "light";
export const DEFAULT_LIGHT_MODEL = "tier:small";

export function modelFor(weight: Weight, projectModel: string): string {
  if (weight === "heavy") return projectModel;
  const set = process.env.GATEWAY_LIGHT_MODEL?.trim();
  if (!set) return DEFAULT_LIGHT_MODEL;
  try { modelRequest(set); } catch {
    // never the value: an env setting can be mistyped with something that should not reach a log
    console.error("[gateway] GATEWAY_LIGHT_MODEL invalid — using the project's model");
    return projectModel;
  }
  return set;
}

// SPEC-112 G4: one gateway call of a round or a quiz answer. Never a key and never content.
export type Call = {
  step: "first" | "reask" | "correction" | "answer";
  weight: Weight;
  asked: string; // the model id requested, e.g. "tier:small"
  model: string | null; // "<provider>/<model>" that answered; null on a failed call
  fallback: boolean; // true on the one extra call on the project's model
  ok: boolean; // the call returned content AND it was readable
  reason: string | null; // the failure code ("protocol" = the reply was not readable), else null
};
