// 클로드 자체 메모리 시스템(~/.claude/projects/<ws>/memory/*.md) 을 read/append.
// MCP 도, 클로드 본인도 같은 디렉토리를 봄. 영구 상태 = 이 폴더뿐.

import { mkdir, readdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./jsonl.js";

function memoryDir(workspaceFolder: string): string {
  return path.join(PROJECTS_ROOT, workspaceFolder, "memory");
}

export interface MemoryFile { name: string; bytes: number; modified_ms: number; content?: string }

export async function listMemory(workspaceFolder: string): Promise<MemoryFile[]> {
  const dir = memoryDir(workspaceFolder);
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const out: MemoryFile[] = [];
  for (const n of names) {
    if (!n.endsWith(".md")) continue;
    const p = path.join(dir, n);
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    out.push({ name: n, bytes: s.size, modified_ms: s.mtimeMs });
  }
  return out.sort((a, b) => b.modified_ms - a.modified_ms);
}

export async function readMemory(workspaceFolder: string, fileName: string): Promise<string> {
  if (fileName.includes("..") || fileName.includes("/")) throw new Error("filename must not include / or ..");
  const p = path.join(memoryDir(workspaceFolder), fileName);
  return readFile(p, "utf8");
}

export async function readAllMemory(workspaceFolder: string): Promise<string> {
  const files = await listMemory(workspaceFolder);
  if (files.length === 0) return "";
  const parts: string[] = [];
  for (const f of files) {
    const content = await readMemory(workspaceFolder, f.name).catch(() => "");
    parts.push(`# ${f.name}\n\n${content}`);
  }
  return parts.join("\n\n---\n\n");
}

export async function appendMemory(workspaceFolder: string, fileName: string, body: string): Promise<{ path: string; bytes: number }> {
  if (fileName.includes("..") || fileName.includes("/")) throw new Error("filename must not include / or ..");
  if (!fileName.endsWith(".md")) fileName += ".md";
  const dir = memoryDir(workspaceFolder);
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, fileName);
  const date = new Date().toISOString().slice(0, 10);
  const block = `\n\n## ${date}\n\n${body.trim()}\n`;
  await appendFile(p, block, "utf8");
  const s = await stat(p);
  return { path: p, bytes: s.size };
}

export async function writeMemory(workspaceFolder: string, fileName: string, content: string): Promise<{ path: string; bytes: number }> {
  if (fileName.includes("..") || fileName.includes("/")) throw new Error("filename must not include / or ..");
  if (!fileName.endsWith(".md")) fileName += ".md";
  const dir = memoryDir(workspaceFolder);
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, fileName);
  await writeFile(p, content, "utf8");
  const s = await stat(p);
  return { path: p, bytes: s.size };
}
