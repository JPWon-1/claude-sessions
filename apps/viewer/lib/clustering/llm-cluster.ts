import { createHash } from "node:crypto";
import { callClaudeCli } from "../summarizer/claude-cli";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ClusterTheme {
  theme_id: string;          // stable hash, e.g. sha1(channelKey + index).slice(0,12)
  title: string;             // 5–10 word Korean title
  session_ids: string[];
}

export interface ClusterInput {
  session_id: string;
  summary: string | null;          // LLM summary if present
  first_user_prompt: string;       // fallback
  started_at: number;              // for the LLM to reason about ordering
}

export interface ClusterResult {
  themes: ClusterTheme[];
  method: "llm-cluster" | "fallback";
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 120;

function themeId(channelKey: string, index: number): string {
  const h = createHash("sha1")
    .update(`${channelKey}|${index}`)
    .digest("hex")
    .slice(0, 12);
  return `theme_${h}`;
}

/**
 * Extract a one-line description for a session.
 * Prefers the "목표:" line from the LLM summary; falls back to first 120 chars
 * of first_user_prompt with whitespace collapsed.
 */
function oneLineDescription(input: ClusterInput): string {
  if (input.summary) {
    const match = input.summary.match(/목표[:\s]+(.+)/);
    if (match) return match[1].trim().slice(0, 120);
  }
  return input.first_user_prompt
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Strip leading/trailing whitespace and any fenced code block markers.
 * Handles:
 *   ```json\n...\n```
 *   ```\n...\n```
 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  // Match an optional language tag after the opening fence
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

function buildPrompt(sessions: ClusterInput[]): string {
  const lines = sessions.map((s, i) => {
    const desc = oneLineDescription(s);
    return `${i + 1}. [${s.session_id}] ${desc}`;
  });

  return `다음은 하나의 프로젝트 채널에서 진행된 Claude 작업 세션 목록입니다.
각 세션은 "[세션ID] 설명" 형식으로 나열되어 있습니다.

${lines.join("\n")}

위 세션들을 작업 의도(intent)를 기준으로 3~8개의 테마 그룹으로 분류하세요.

규칙:
- 응답은 JSON 객체만 출력. 다른 텍스트 금지.
- 모든 session_id가 정확히 하나의 theme에 속해야 함.
- 5~10단어 제목 (한국어).
- 3~8개 테마.

응답 형식:
{
  "themes": [
    { "title": "테마 제목 예시", "session_ids": ["session_id_1", "session_id_2"] }
  ]
}`;
}

function makeFallback(channelKey: string, sessionIds: string[], reason: string): ClusterResult {
  return {
    themes: [{
      theme_id: themeId(channelKey + "all", 0),
      title: "분류 실패 — 전체 세션",
      session_ids: sessionIds,
    }],
    method: "fallback",
    reason,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function clusterSessionsByLLM(
  channelKey: string,
  sessions: ClusterInput[],
  opts?: { timeoutMs?: number }
): Promise<ClusterResult> {
  // 1. Empty input short-circuit
  if (sessions.length === 0) {
    return { themes: [], method: "llm-cluster" };
  }

  // Hard-cap to MAX_SESSIONS most recent sessions
  const capped = sessions.length > MAX_SESSIONS
    ? [...sessions].sort((a, b) => b.started_at - a.started_at).slice(0, MAX_SESSIONS)
    : sessions;

  const allInputIds = new Set(capped.map(s => s.session_id));

  // 2. Build prompt and call CLI
  const prompt = buildPrompt(capped);
  const cliResult = await callClaudeCli(prompt, opts?.timeoutMs ?? 60_000);

  if (!cliResult.ok) {
    return makeFallback(
      channelKey,
      [...allInputIds],
      `CLI failed: ${cliResult.reason ?? "unknown"}`
    );
  }

  // 3. Parse JSON, tolerating fenced code blocks
  let parsed: { themes: Array<{ title: string; session_ids: string[] }> };
  try {
    const cleaned = stripFences(cliResult.stdout);
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return makeFallback(
      channelKey,
      [...allInputIds],
      `JSON parse failed: ${(err as Error).message}`
    );
  }

  // 4. Validate
  if (!Array.isArray(parsed?.themes)) {
    return makeFallback(channelKey, [...allInputIds], "Response missing 'themes' array");
  }

  const returnedIds = new Set<string>();
  for (const theme of parsed.themes) {
    if (!Array.isArray(theme.session_ids)) {
      return makeFallback(channelKey, [...allInputIds], "Theme missing 'session_ids' array");
    }
    for (const id of theme.session_ids) {
      // Unknown ID in response
      if (!allInputIds.has(id)) {
        return makeFallback(channelKey, [...allInputIds], `Unknown session_id in response: ${id}`);
      }
      // Duplicate ID across themes
      if (returnedIds.has(id)) {
        return makeFallback(channelKey, [...allInputIds], `Duplicate session_id in response: ${id}`);
      }
      returnedIds.add(id);
    }
  }

  // Every input must appear in exactly one theme
  const missingIds = [...allInputIds].filter(id => !returnedIds.has(id));
  if (missingIds.length > 0) {
    return makeFallback(
      channelKey,
      [...allInputIds],
      `Missing session_ids in response: ${missingIds.join(", ")}`
    );
  }

  // 5. Assemble result with stable theme_ids
  const themes: ClusterTheme[] = parsed.themes.map((t, i) => ({
    theme_id: themeId(channelKey, i),
    title: t.title,
    session_ids: t.session_ids,
  }));

  return { themes, method: "llm-cluster" };
}
