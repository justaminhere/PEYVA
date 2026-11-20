import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Append-only JSONL session log in output/ (git-ignored). Never contains API keys. */
export async function sessionLogger(kind: string) {
  const dir = join(import.meta.dir, "..", "..", "output", "sessions");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  return { file, write: (rec: Record<string, unknown>) => appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n") };
}
