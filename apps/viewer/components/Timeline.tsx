"use client";
interface Marker { kind: "tool" | "error" | "commit" | "permission" | "decision"; label: string; t: number; idx: number; }
function formatTime(ms: number) { return new Date(ms).toLocaleTimeString("ko-KR"); }

export function Timeline({ events, onJump }: { events: any[]; onJump: (idx: number) => void }) {
  const markers: Marker[] = [];
  events.forEach((e, idx) => {
    const t = Date.parse(e.timestamp ?? "") || 0;
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === "tool_use") {
          markers.push({ kind: "tool", label: `🔧 ${b.name}`, t, idx });
        }
      }
    }
    if (e.type === "system" && e.subtype === "stop_reason") {
      markers.push({ kind: "decision", label: `⏸ ${e.stopReason ?? "stop"}`, t, idx });
    }
    if (e.type === "system" && (e.hookErrors?.length || e.preventedContinuation)) {
      markers.push({ kind: "error", label: `⚠ hook error`, t, idx });
    }
    if (e.type === "user" && typeof e.message?.content === "string" &&
        /\bgit (commit|push)\b/.test(e.message.content)) {
      markers.push({ kind: "commit", label: `✅ git op`, t, idx });
    }
  });
  return (
    <ol className="border-l border-neutral-800 ml-2 pl-3 space-y-1 text-xs">
      {markers.map((m, i) => (
        <li key={i}>
          <button onClick={() => onJump(m.idx)} className="hover:text-white text-neutral-400">
            <span className="text-neutral-500 mr-2">{formatTime(m.t)}</span>{m.label}
          </button>
        </li>
      ))}
      {markers.length === 0 && <li className="text-neutral-500">No markers in this session.</li>}
    </ol>
  );
}
