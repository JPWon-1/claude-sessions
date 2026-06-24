import { spawn } from "node:child_process";

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason?: "missing" | "timeout" | "exit-nonzero" | "error";
}

const SUMMARIZER_MODEL = process.env.CLAUDE_VIEWER_MODEL ?? "haiku";

export async function callClaudeCli(prompt: string, timeoutMs = 60_000): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let child;
    try {
      child = spawn("claude", ["-p", "--model", SUMMARIZER_MODEL, prompt], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ ok: false, stdout: "", stderr: "", reason: "missing" });
    }

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", d => { stdout += d.toString(); });
    child.stderr?.on("data", d => { stderr += d.toString(); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, reason: "missing" });
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, stdout, stderr, reason: "timeout" });
      if (code !== 0) return resolve({ ok: false, stdout, stderr, reason: "exit-nonzero" });
      resolve({ ok: true, stdout: stdout.trim(), stderr });
    });
  });
}
