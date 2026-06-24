/**
 * Normalize a user prompt so that copies of the same automated invocation hash to the same value
 * even when small variable parts differ (numbers, quoted strings, file paths, command tails).
 *
 * Rules:
 * - trim + collapse runs of whitespace to single space
 * - mask sequences of digits to '<N>'
 * - mask single-quoted, double-quoted, and backticked strings to '<STR>'
 * - mask absolute filesystem paths (start with /) and relative ones containing '/' to '<PATH>'
 * - take only the first 200 chars after normalization (long tails diverge; intent is in the head)
 */
export function normalizePrompt(input: string): string {
  let s = input;

  // 1. Drop content after a double-newline paragraph break (variable "command tail")
  //    e.g. "Explain this:\n\ngit log -10 --oneline" → "Explain this:"
  const paraBreak = s.indexOf("\n\n");
  if (paraBreak !== -1) {
    s = s.slice(0, paraBreak);
  }

  // 2. Mask quoted strings (double, single, backtick) before paths/numbers to avoid partial masking
  s = s.replace(/"[^"]*"/g, "<STR>");
  s = s.replace(/'[^']*'/g, "<STR>");
  s = s.replace(/`[^`]*`/g, "<STR>");

  // 3. Mask filesystem paths: absolute (starting with /) or relative with at least one /
  s = s.replace(/(?:[\w.-]+\/)+[\w.-]*/g, "<PATH>");
  s = s.replace(/\/[\w.-][^\s]*/g, "<PATH>");

  // 4. Mask sequences of digits
  s = s.replace(/\d+/g, "<N>");

  // 5. Collapse whitespace (including newlines) to single space, trim
  s = s.replace(/\s+/g, " ").trim();

  // 6. Take first 200 chars
  return s.slice(0, 200);
}
