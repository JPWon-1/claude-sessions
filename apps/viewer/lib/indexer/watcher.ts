import chokidar from "chokidar";
import { homedir } from "node:os";
import path from "node:path";
import { ingestJsonlFile } from "./ingest";
import { sweepCompletions } from "./completion";
import { rebuildTopicsForChannel, rebuildAllTopics } from "./scan";
import { backfillSummaries } from "../summarizer/summarize";
import { listChannelsForJsonl } from "../db/queries";

const PROJECTS_ROOT = path.join(homedir(), ".claude", "projects");

let started = false;

export function startWatcher(): void {
  if (started) return;
  started = true;

  const watcher = chokidar.watch(`${PROJECTS_ROOT}/**/*.jsonl`, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  });

  const onChange = async (file: string) => {
    await ingestJsonlFile(file);
    sweepCompletions();
    const affected = listChannelsForJsonl(file);
    for (const { project_path, git_branch } of affected) {
      await rebuildTopicsForChannel(project_path, git_branch);
    }
    backfillSummaries();
  };

  watcher.on("add", onChange);
  watcher.on("change", onChange);

  // Periodic full pass for global automation re-detection.
  // (Per-channel rebuilds skip detectAutomationPatterns; we want a recurring
  //  global sweep so cross-channel hook patterns get re-counted as new
  //  invocations accumulate.)
  setInterval(() => {
    void rebuildAllTopics()
      .then(() => backfillSummaries())
      .catch(() => undefined);
  }, 5 * 60 * 1000);
}
