"use client";
import { forwardRef } from "react";

const MAX_TEXT_BLOCK = 4000;
const BASE64_RE = /(?:[A-Za-z0-9+/]{120,}={0,2})/;

function isLikelyBinaryDump(s: string): boolean {
  if (s.length < 200) return false;
  return BASE64_RE.test(s);
}

function truncate(s: string): string {
  if (s.length <= MAX_TEXT_BLOCK) return s;
  return `${s.slice(0, MAX_TEXT_BLOCK)}\n…(${s.length - MAX_TEXT_BLOCK} more chars hidden)`;
}

function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return isLikelyBinaryDump(content)
      ? `(binary data, ${content.length} chars hidden)`
      : truncate(content);
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const block = b as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(isLikelyBinaryDump(block.text)
          ? `(binary text block, ${(block.text as string).length} chars hidden)`
          : truncate(block.text as string));
      } else if (block.type === "image") {
        const src = block.source as { media_type?: string; data?: string } | undefined;
        const kind = src?.media_type ?? "image";
        const size = typeof src?.data === "string" ? src.data.length : 0;
        parts.push(`🖼 [${kind}, ${size} base64 chars hidden]`);
      } else if (typeof block.type === "string") {
        parts.push(`[${block.type}]`);
      }
    }
    return parts.join("\n");
  }
  return `(unrenderable content)`;
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return truncate(content);
  if (Array.isArray(content)) {
    return content.map((b: unknown) => {
      if (!b || typeof b !== "object") return "";
      const block = b as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return truncate(block.text);
      if (block.type === "tool_use") {
        const name = block.name ?? "?";
        const input = block.input ?? {};
        const inputStr = JSON.stringify(input, null, 2);
        return `[tool_use: ${name}]\n${truncate(inputStr)}`;
      }
      if (block.type === "tool_result") {
        return `[tool_result]\n${renderToolResultContent(block.content)}`;
      }
      if (block.type === "image") {
        const src = block.source as { media_type?: string; data?: string } | undefined;
        const kind = src?.media_type ?? "image";
        const size = typeof src?.data === "string" ? src.data.length : 0;
        return `🖼 [${kind}, ${size} base64 chars hidden]`;
      }
      return "";
    }).filter(Boolean).join("\n\n");
  }
  return "";
}

function renderHighlighted(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const found = lower.indexOf(q, i);
    if (found < 0) { out.push(text.slice(i)); break; }
    if (found > i) out.push(text.slice(i, found));
    out.push(
      <mark key={`m-${key++}`} className="bg-yellow-700/60 text-white px-0.5 rounded">
        {text.slice(found, found + q.length)}
      </mark>
    );
    i = found + q.length;
  }
  return <>{out}</>;
}

export const Transcript = forwardRef<HTMLDivElement, { events: any[]; query?: string; onMatchCount?: (n: number) => void }>(
  function Transcript({ events, query = "", onMatchCount }, ref) {
    const q = query.trim();
    const matches = (text: string) => q.length >= 2 ? (text.toLowerCase().match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase(), "g")) ?? []).length : 0;

    let total = 0;
    const articles = events.map((e, i) => {
      if (e.type !== "user" && e.type !== "assistant") return null;
      const text = renderContent(e.message?.content);
      if (!text) return null;
      const isUser = e.type === "user";
      const role = isUser ? "USER" : "ASSISTANT";
      const cnt = matches(text);
      total += cnt;
      const hidden = q.length >= 2 && cnt === 0;
      const cardCls = isUser
        ? "bg-sky-950/40 border-l-4 border-l-sky-500 border-y border-r border-neutral-800"
        : "bg-emerald-950/30 border-l-4 border-l-emerald-600 border-y border-r border-neutral-800";
      const labelCls = isUser ? "text-sky-400" : "text-emerald-400";
      return (
        <article
          key={i}
          id={`evt-${i}`}
          data-match-count={cnt}
          className={`rounded-r p-3 text-sm whitespace-pre-wrap ${cardCls} ${hidden ? "hidden" : ""}`}
        >
          <div className={`text-[10px] uppercase font-semibold tracking-wider mb-1 ${labelCls}`}>
            {role}
            {cnt > 0 && q && <span className="ml-2 text-yellow-400">· {cnt} match{cnt > 1 ? "es" : ""}</span>}
          </div>
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-neutral-100">
            {q.length >= 2 ? renderHighlighted(text, q) : text}
          </pre>
        </article>
      );
    });

    if (onMatchCount) onMatchCount(total);

    return (
      <div ref={ref} className="space-y-3">
        {articles}
      </div>
    );
  }
);
