// Originals on disk, stored once by content: <dir>/<sha[0..2]>/<sha>. Never rewritten once there.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const storedAsOf = (sha256: string) => `${sha256.slice(0, 2)}/${sha256}`;

export async function saveOriginal(dir: string, bytes: Uint8Array): Promise<{ sha256: string; storedAs: string }> {
  const sha256 = sha256Of(bytes);
  const storedAs = storedAsOf(sha256);
  const target = join(dir, storedAs);
  if (!existsSync(target)) {
    await mkdir(dirname(target), { recursive: true });
    // Write beside the target, then rename: a reader never sees half a file.
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, target);
  }
  return { sha256, storedAs };
}
