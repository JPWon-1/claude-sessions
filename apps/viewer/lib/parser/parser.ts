import { createReadStream } from "node:fs";
import readline from "node:readline";
import type { ParsedEvent } from "../types";

const KNOWN_TYPES = new Set([
  "user", "assistant", "system", "attachment",
  "file-history-snapshot", "last-prompt", "permission-mode"
]);

function toEpochMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

export async function* parseJsonlFromOffset(
  filePath: string,
  startOffset: number
): AsyncGenerator<{ event: ParsedEvent; offset: number }> {
  const stream = createReadStream(filePath, { start: startOffset, encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cursor = startOffset;

  for await (const rawLine of rl) {
    const lineBytes = Buffer.byteLength(rawLine, "utf8") + 1; // + newline
    cursor += lineBytes;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(rawLine);
    } catch {
      continue; // skip malformed
    }

    const t = typeof obj.type === "string" ? obj.type : "unknown";
    const event: ParsedEvent = {
      type: KNOWN_TYPES.has(t) ? (t as ParsedEvent["type"]) : "unknown",
      raw: obj,
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : undefined,
      timestamp: toEpochMs(obj.timestamp),
      cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
      gitBranch: typeof obj.gitBranch === "string" ? obj.gitBranch : undefined
    };
    yield { event, offset: cursor };
  }
}
