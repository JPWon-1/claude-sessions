"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface AutomationPattern {
  pattern_id: string;
  normalized_prompt: string;
  sample_prompt: string;
  global_count: number;
  channel_count: number;
  first_seen: number;
  last_seen: number;
}

interface AutomationSession {
  session_id: string;
  started_at: number;
  first_user_prompt: string;
}

interface Props {
  projectPath: string;
  branch: string | null;
}

function formatDateKR(ms: number) {
  return new Date(ms).toLocaleDateString("ko-KR");
}

function collapseWhitespace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function PatternRow({
  pattern,
  onDeleted,
}: {
  pattern: AutomationPattern;
  onDeleted: (patternId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<AutomationSession[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next && sessions === null && !loading) {
      setLoading(true);
      try {
        const res = await fetch(`/api/automation/${encodeURIComponent(pattern.pattern_id)}`);
        const data = await res.json();
        setSessions(data.sessions ?? []);
      } finally {
        setLoading(false);
      }
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const confirmed1 = window.confirm(
      `이 패턴은 ${pattern.global_count}개 세션 전체(여러 채널 포함)가 삭제됩니다. 진짜?`
    );
    if (!confirmed1) return;
    const confirmed2 = window.confirm("복구 불가능합니다. 한 번 더 확인.");
    if (!confirmed2) return;

    setDeleting(true);
    setDeleteStatus(null);
    try {
      const res = await fetch(`/api/automation/${encodeURIComponent(pattern.pattern_id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) {
        setDeleteStatus({ ok: true, message: `✅ ${data.filesDeleted}개 파일 삭제됨` });
        setTimeout(() => onDeleted(pattern.pattern_id), 1200);
      } else {
        const errDetail = data.errors?.join(", ") ?? "알 수 없는 오류";
        setDeleteStatus({ ok: false, message: `오류: ${errDetail}` });
      }
    } catch (err: unknown) {
      setDeleteStatus({ ok: false, message: `오류: ${(err as Error).message}` });
    } finally {
      setDeleting(false);
    }
  }

  const title = collapseWhitespace(pattern.sample_prompt).slice(0, 80);
  const firstDate = formatDateKR(pattern.first_seen);
  const lastDate = formatDateKR(pattern.last_seen);
  const dateRange = firstDate === lastDate ? firstDate : `${firstDate}~${lastDate}`;

  return (
    <div className="border border-neutral-800 rounded mb-2">
      <div className="flex items-center">
        <button
          onClick={handleToggle}
          className="flex-1 flex items-center justify-between px-3 py-2 text-left hover:bg-neutral-800/50 transition-colors min-w-0"
        >
          <span className="text-sm text-neutral-300 truncate pr-3">{title || "(no prompt)"}</span>
          <span className="text-xs text-neutral-500 whitespace-nowrap flex-shrink-0">
            · {pattern.channel_count}회 · {dateRange}
          </span>
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          title={`패턴 삭제 (전체 ${pattern.global_count}개 세션)`}
          className="px-2 py-2 text-sm opacity-30 hover:opacity-80 transition-opacity disabled:opacity-10 flex-shrink-0"
        >
          🗑
        </button>
      </div>
      {deleteStatus && (
        <div
          className={`px-3 py-1 text-xs border-t border-neutral-800 ${
            deleteStatus.ok ? "text-green-400" : "text-red-400"
          }`}
        >
          {deleteStatus.message}
        </div>
      )}
      {open && (
        <div className="border-t border-neutral-800 px-3 py-2 bg-neutral-900/50">
          {loading && <p className="text-xs text-neutral-500">로딩 중…</p>}
          {!loading && sessions && sessions.length === 0 && (
            <p className="text-xs text-neutral-500">세션 없음</p>
          )}
          {!loading && sessions && sessions.length > 0 && (
            <ul className="space-y-1">
              {sessions.map((s) => (
                <li key={s.session_id}>
                  <Link
                    href={`/session/${s.session_id}`}
                    className="flex items-center gap-2 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                  >
                    <span className="text-neutral-600 whitespace-nowrap">
                      {new Date(s.started_at).toLocaleString("ko-KR")}
                    </span>
                    <span className="truncate">
                      {collapseWhitespace(s.first_user_prompt || "").slice(0, 60) || "(no prompt)"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function AutomationSection({ projectPath, branch }: Props) {
  const [patterns, setPatterns] = useState<AutomationPattern[] | null>(null);
  const [sectionOpen, setSectionOpen] = useState(true);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ projectPath });
    if (branch != null) params.set("branch", branch);
    fetch(`/api/automation?${params}`)
      .then((r) => r.json())
      .then((data) => setPatterns(data.patterns ?? []));
  }, [projectPath, branch]);

  if (patterns === null || patterns.length === 0) return null;

  function handlePatternDeleted(patternId: string) {
    setPatterns((prev) => prev?.filter((p) => p.pattern_id !== patternId) ?? []);
  }

  async function handleBulkDelete() {
    if (!patterns) return;
    const total = patterns.reduce((a, p) => a + p.channel_count, 0);
    const confirmed1 = window.confirm(
      `이 채널의 자동화 세션 ${total}개 + jsonl 파일을 영구 삭제합니다. 정말?`
    );
    if (!confirmed1) return;
    const confirmed2 = window.confirm("복구 불가능합니다. 한 번 더 확인.");
    if (!confirmed2) return;

    setBulkDeleting(true);
    setBulkStatus(null);
    try {
      const sp = new URLSearchParams({ projectPath });
      if (branch != null) sp.set("branch", branch);
      const res = await fetch(`/api/automation?${sp}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setBulkStatus({ ok: true, message: `✅ ${data.filesDeleted}개 파일 삭제됨` });
        setTimeout(() => setPatterns([]), 1200);
      } else {
        const errDetail = data.errors?.join(", ") ?? "알 수 없는 오류";
        setBulkStatus({ ok: false, message: `오류: ${errDetail}` });
      }
    } catch (err: unknown) {
      setBulkStatus({ ok: false, message: `오류: ${(err as Error).message}` });
    } finally {
      setBulkDeleting(false);
    }
  }

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setSectionOpen((v) => !v)}
          className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity"
        >
          <h3 className="text-sm font-semibold text-neutral-200">
            🤖 자동화 호출 ({patterns.length}개 패턴)
          </h3>
          <span className="text-xs text-neutral-500">{sectionOpen ? "▲" : "▼"}</span>
        </button>
        <button
          onClick={handleBulkDelete}
          disabled={bulkDeleting}
          className="text-xs text-neutral-500 hover:text-red-400 transition-colors disabled:opacity-30 px-2 py-1 rounded border border-neutral-700 hover:border-red-800"
        >
          이 채널의 모든 자동화 삭제
        </button>
      </div>
      {bulkStatus && (
        <div
          className={`mb-2 px-3 py-1 text-xs rounded ${
            bulkStatus.ok ? "text-green-400 bg-green-900/20" : "text-red-400 bg-red-900/20"
          }`}
        >
          {bulkStatus.message}
        </div>
      )}
      {sectionOpen && (
        <div>
          {patterns.map((p) => (
            <PatternRow key={p.pattern_id} pattern={p} onDeleted={handlePatternDeleted} />
          ))}
        </div>
      )}
    </section>
  );
}
