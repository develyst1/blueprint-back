import { PART_KINDS, type PartKind } from "./registry";

export const KEY_RE = /^(WRK|STEP|INT|ROLE|SCR|API|SYS|DATA|DEC|Q|CON)-\d{3,}$/;

const KIND_BY_PREFIX = new Map<string, PartKind>(
  (Object.keys(PART_KINDS) as PartKind[]).map((kind) => [PART_KINDS[kind].prefix, kind]),
);

function split(key: string): { prefix: string; number: number } {
  if (!KEY_RE.test(key)) throw new Error(`not a part key: "${key}"`);
  const dash = key.lastIndexOf("-");
  return { prefix: key.slice(0, dash), number: Number(key.slice(dash + 1)) };
}

export function kindOfKey(key: string): PartKind {
  return KIND_BY_PREFIX.get(split(key).prefix)!;
}

export function compareKeys(a: string, b: string): number {
  const x = split(a);
  const y = split(b);
  if (x.prefix !== y.prefix) return x.prefix < y.prefix ? -1 : 1;
  return x.number - y.number;
}

// `existingKeys` must hold every key ever issued in the project, removed parts included,
// so a key is never reused.
export function nextKey(kind: PartKind, existingKeys: string[]): string {
  const prefix = PART_KINDS[kind].prefix;
  let highest = 0;
  for (const key of existingKeys) {
    const k = split(key);
    if (k.prefix === prefix && k.number > highest) highest = k.number;
  }
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}
