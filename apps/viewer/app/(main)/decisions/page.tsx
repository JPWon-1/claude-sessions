"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface DecisionEntry {
  session_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  goal: string | null;
  decisions: string[];
}

function isoWeekLabel(ts: number): string {
  const d = new Date(ts);
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diffToMon);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return `${fmtDate(mon)} ~ ${fmtDate(sun)}`;
}

function isoWeekKey(ts: number): string {
  const d = new Date(ts);
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diffToMon);
  mon.setHours(0, 0, 0, 0);
  return mon.toISOString().slice(0, 10);
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).slice(-1)[0] ?? path;
}

export default function DecisionsPage() {
  const [entries, setEntries] = useState<DecisionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/decisions")
      .then(r => r.json())
      .then(data => setEntries(data.entries ?? []))
      .finally(() => setLoading(false));
  }, []);

  const filterLower = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!filterLower) return entries;
    return entries
      .map(e => {
        const goalHit = (e.goal ?? "").toLowerCase().includes(filterLower);
        const folderHit = folderName(e.project_path).toLowerCase().includes(filterLower);
        const decisionsHit = e.decisions.filter(d => d.toLowerCase().includes(filterLower));
        if (goalHit || folderHit) return e;
        if (decisionsHit.length > 0) return { ...e, decisions: decisionsHit };
        return null;
      })
      .filter((e): e is DecisionEntry => e !== null);
  }, [entries, filterLower]);

  // Group by week, then by project — but each session is ONE block, decisions are bullets.
  const byWeek: Map<string, { label: string; byProject: Map<string, DecisionEntry[]> }> = new Map();
  for (const entry of matches) {
    const wk = isoWeekKey(entry.started_at);
    if (!byWeek.has(wk)) {
      byWeek.set(wk, { label: isoWeekLabel(entry.started_at), byProject: new Map() });
    }
    const folder = folderName(entry.project_path);
    const proj = byWeek.get(wk)!.byProject;
    if (!proj.has(folder)) proj.set(folder, []);
    proj.get(folder)!.push(entry);
  }

  const totalDecisions = matches.reduce((n, e) => n + e.decisions.length, 0);
  const totalSessions = matches.length;

  function buildMarkdown(): string {
    const lines: string[] = ["# 결정 로그", ""];
    for (const [, { label, byProject }] of byWeek) {
      lines.push(`## ${label}`, "");
      for (const [proj, ents] of byProject) {
        lines.push(`### ${proj}`, "");
        for (const e of ents) {
          const url = `/session/${e.session_id}`;
          lines.push(`#### [${e.goal ?? "목표 없음"}](${url}) — ${fmtDate(new Date(e.started_at))}`);
          for (const d of e.decisions) lines.push(`- ${d}`);
          lines.push("");
        }
      }
    }
    return lines.join("\n");
  }

  function copyMarkdown() {
    navigator.clipboard.writeText(buildMarkdown()).catch(() => {});
  }

  if (loading) {
    return <main className="p-6 text-neutral-400 text-sm">불러오는 중…</main>;
  }

  return (
    <main className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-neutral-100">결정 로그</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-neutral-400">
            {totalSessions}세션 · {totalDecisions}개 결정
          </span>
          {totalDecisions > 0 && (
            <button
              onClick={copyMarkdown}
              className="text-xs px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
            >
              마크다운 복사
            </button>
          )}
        </div>
      </div>

      <input
        type="search"
        placeholder="🔍 목표·결정·폴더로 필터…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="w-full text-sm px-3 py-1.5 mb-6 rounded bg-neutral-900 border border-neutral-800 text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
      />

      {entries.length === 0 ? (
        <div className="text-neutral-500 text-sm py-8 text-center">
          아직 주요 결정이 기록된 세션이 없습니다.
          <br />
          <span className="text-neutral-600">새 세션 요약에 "주요 결정" 섹션이 생기면 여기에 표시됩니다.</span>
        </div>
      ) : matches.length === 0 ? (
        <p className="text-neutral-500 text-sm">매칭된 결정이 없습니다.</p>
      ) : (
        <div className="space-y-8">
          {Array.from(byWeek.entries()).map(([wk, { label, byProject }]) => (
            <section key={wk}>
              <h2 className="text-sm font-semibold text-neutral-400 mb-3 pb-1 border-b border-neutral-800 sticky top-0 bg-neutral-950 py-1 z-10">
                {label}
              </h2>

              <div className="space-y-6">
                {Array.from(byProject.entries()).map(([proj, ents]) => (
                  <div key={proj}>
                    <h3 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">📁 {proj}</h3>

                    <div className="space-y-3">
                      {ents.map(e => (
                        <article
                          key={e.session_id}
                          className="border-l-2 border-l-amber-700 border-y border-r border-neutral-800 bg-neutral-900/50 rounded-r p-3"
                        >
                          <header className="flex items-baseline justify-between gap-3 mb-2">
                            <Link
                              href={`/session/${e.session_id}`}
                              className="text-sm text-neutral-100 hover:text-amber-300 truncate font-medium"
                              title={e.goal ?? ""}
                            >
                              {e.goal ?? "(목표 없음)"}
                            </Link>
                            <span className="text-[11px] text-neutral-500 shrink-0 whitespace-nowrap">
                              {fmtDate(new Date(e.started_at))}
                              {e.git_branch && <span className="ml-2 text-neutral-600">#{e.git_branch}</span>}
                            </span>
                          </header>
                          <ul className="space-y-1 ml-4 list-disc list-outside marker:text-amber-700">
                            {e.decisions.map((d, i) => (
                              <li key={i} className="text-sm text-neutral-200 leading-relaxed">{d}</li>
                            ))}
                          </ul>
                        </article>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
