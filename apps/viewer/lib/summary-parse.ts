export interface ParsedSummary {
  goal?: string;
  did?: string;
  outcome?: string;
  outcomeKind?: "success" | "partial" | "stuck" | "unknown";
  decisions: string[];
  questions: string[];
}

// Recognize both label styles:
//   "목표: ..."        — original strict format
//   "## 목표"          — markdown heading (Haiku tends to emit this)
//   "**목표**: ..."    — bold variant
// Captures: 1 = label, 2 = inline tail (may be empty when on next line)
const HEADER_RE = /^\s*(?:#{1,6}\s+|\*\*)?(목표|한 일|결과|주요 결정|주요 질문)(?:\*\*)?\s*[:：]?\s*(.*)$/;

export function parseSummary(summary: string | null | undefined): ParsedSummary {
  const out: ParsedSummary = { decisions: [], questions: [] };
  if (!summary) return out;

  // Multi-line section accumulator. Some sections (goal/did/outcome) can have
  // their content on the line following the header (markdown style) instead of
  // on the same line as the label.
  type SectionKey = "goal" | "did" | "outcome" | "decisions" | "questions";
  let section: SectionKey | null = null;
  const buf: string[] = [];

  function flush() {
    if (!section) { buf.length = 0; return; }
    const text = buf.join("\n").trim();
    if (section === "goal") out.goal = (out.goal && out.goal.length ? out.goal : text) || undefined;
    else if (section === "did") out.did = (out.did && out.did.length ? out.did : text) || undefined;
    else if (section === "outcome") {
      const t = (out.outcome && out.outcome.length ? out.outcome : text) || "";
      out.outcome = t || undefined;
      out.outcomeKind = classifyOutcome(t);
    }
    buf.length = 0;
  }

  for (const rawLine of summary.split("\n")) {
    const h = rawLine.match(HEADER_RE);
    if (h) {
      flush();
      const label = h[1];
      const tail = (h[2] ?? "").trim();
      switch (label) {
        case "목표":
          section = "goal";
          if (tail) out.goal = tail;
          break;
        case "한 일":
          section = "did";
          if (tail) out.did = tail;
          break;
        case "결과":
          section = "outcome";
          if (tail) {
            out.outcome = tail;
            out.outcomeKind = classifyOutcome(tail);
          }
          break;
        case "주요 결정":
          section = "decisions";
          break;
        case "주요 질문":
          section = "questions";
          break;
      }
      continue;
    }

    const trimmed = rawLine.trim();

    if (section === "decisions" || section === "questions") {
      if (!trimmed) continue;
      // Accept "- foo", "* foo", "• foo", "1. foo", or bare lines as items.
      const item = trimmed.replace(/^([-*•]|\d+\.)\s+/, "").trim();
      if (!item || item === "없음") continue;
      if (section === "decisions") out.decisions.push(item);
      else out.questions.push(item);
      continue;
    }

    // For goal/did/outcome, accumulate non-empty lines until next header.
    if (section && trimmed) buf.push(trimmed);
    if (section && !trimmed) flush();      // blank line ends the inline section
  }
  flush();

  return out;
}

function classifyOutcome(s: string): ParsedSummary["outcomeKind"] {
  const lower = s.toLowerCase();
  if (lower.includes("부분성공") || lower.includes("부분 성공")) return "partial";
  if (lower.includes("막힘") || lower.includes("실패")) return "stuck";
  if (lower.includes("성공")) return "success";
  return "unknown";
}
