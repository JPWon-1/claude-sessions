"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface Workspace { project_path: string; session_count: number; }
interface Channel    { git_branch: string | null; session_count: number; }
type ChannelsByPath = Record<string, Channel[]>;

const LS_KEY = "claude-viewer:expanded";

function readExpanded(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeExpanded(next: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* quota */ }
}

export function Sidebar() {
  const pathname = usePathname();
  const [filter, setFilter] = useState("");

  const { activePath, activeBranch } = useMemo(() => {
    const m = pathname.match(/^\/w\/([^/]+)\/([^/]+)/);
    if (!m) return { activePath: undefined, activeBranch: null };
    const p = decodeURIComponent(m[1]);
    const bRaw = decodeURIComponent(m[2]);
    const b = bRaw === "(no branch)" ? null : bRaw;
    return { activePath: p, activeBranch: b };
  }, [pathname]);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channelsByPath, setChannelsByPath] = useState<ChannelsByPath>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setExpanded(readExpanded());
  }, []);

  useEffect(() => {
    if (!activePath) return;
    setExpanded(prev => {
      if (prev[activePath]) return prev;
      const next = { ...prev, [activePath]: true };
      writeExpanded(next);
      return next;
    });
  }, [activePath]);

  async function loadData() {
    setLoading(true);
    try {
      const [w, c] = await Promise.all([
        fetch("/api/workspaces").then(r => r.json()),
        fetch("/api/channels/all").then(r => r.json())
      ]);
      setWorkspaces(w.workspaces ?? []);
      setChannelsByPath(c.channelsByPath ?? {});
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  function toggle(path: string) {
    setExpanded(prev => {
      const next = { ...prev, [path]: !prev[path] };
      writeExpanded(next);
      return next;
    });
  }

  async function refresh() {
    await fetch("/api/refresh", { method: "POST" });
    await loadData();
  }

  // Filter workspaces and channels by the live filter input.
  const filterLower = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!filterLower) return workspaces;
    return workspaces.filter(ws => {
      // Match on full project path or folder basename.
      if (ws.project_path.toLowerCase().includes(filterLower)) return true;
      // Or any of its channel names.
      const chs = channelsByPath[ws.project_path] ?? [];
      return chs.some(c => (c.git_branch ?? "").toLowerCase().includes(filterLower));
    });
  }, [workspaces, channelsByPath, filterLower]);

  return (
    <aside className="w-72 shrink-0 border-r border-neutral-800 h-screen overflow-y-auto p-3">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-sm font-semibold text-neutral-300">Claude Sessions</h1>
        <button onClick={refresh} className="text-xs px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700">Refresh</button>
      </div>
      <div className="mb-3 space-y-0.5">
        {[
          { href: "/", label: "홈" },
          { href: "/resume", label: "▶ 이어서 작업" },
          { href: "/decisions", label: "🗒 결정 로그" },
          { href: "/stuck", label: "🚧 막힌 작업" },
          { href: "/digest", label: "📅 주간 다이제스트" },
        ].map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={`block text-xs px-2 py-1 rounded ${pathname === item.href ? "bg-neutral-700 text-white" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"}`}
          >
            {item.label}
          </Link>
        ))}
      </div>
      <div className="mb-3">
        <input
          type="search"
          placeholder="🔍 워크스페이스/브랜치 필터…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-full text-sm px-2 py-1 rounded bg-neutral-900 border border-neutral-800 text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
        />
        {filterLower && (
          <p className="text-[10px] text-neutral-500 mt-1">
            {filtered.length}/{workspaces.length} 매칭 ·{" "}
            <button onClick={() => setFilter("")} className="hover:text-neutral-200 underline">지우기</button>
          </p>
        )}
      </div>
      {loading && workspaces.length === 0 && (
        <p className="text-xs text-neutral-500">Loading…</p>
      )}
      <nav className="space-y-1">
        {filtered.map(ws => {
          const folderName = ws.project_path.split("/").filter(Boolean).slice(-1)[0] || ws.project_path;
          const isOpen = !!expanded[ws.project_path] || !!filterLower;  // auto-expand when filtering
          const channels = channelsByPath[ws.project_path] ?? [];
          return (
            <div key={ws.project_path}>
              <button
                onClick={() => toggle(ws.project_path)}
                className="w-full text-left text-sm px-2 py-1 rounded hover:bg-neutral-800 flex justify-between items-center"
                aria-expanded={isOpen}
              >
                <span className="truncate pr-2">
                  <span className="inline-block w-3 text-neutral-500">{isOpen ? "▾" : "▸"}</span> 📁 {folderName}
                </span>
                <span className="text-neutral-500 shrink-0">{ws.session_count}</span>
              </button>
              {isOpen && channels.length === 0 && (
                <div className="ml-8 text-xs text-neutral-600 py-0.5">(no channels)</div>
              )}
              {isOpen && channels.map(ch => {
                const branch = ch.git_branch ?? "(no branch)";
                const isActive = activePath === ws.project_path && (activeBranch ?? "") === (ch.git_branch ?? "");
                const href = `/w/${encodeURIComponent(ws.project_path)}/${encodeURIComponent(branch)}`;
                return (
                  <Link
                    key={branch}
                    href={href}
                    className={`block ml-7 text-xs px-2 py-1 rounded ${isActive ? "bg-neutral-700 text-white" : "hover:bg-neutral-800 text-neutral-300"}`}
                  >
                    # {branch} <span className="text-neutral-500">{ch.session_count}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
