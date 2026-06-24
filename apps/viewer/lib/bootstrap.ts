import { fullScan, rebuildAllTopics } from "./indexer/scan";
import { startWatcher } from "./indexer/watcher";
import { backfillSummaries } from "./summarizer/summarize";

let booted = false;
let bootPromise: Promise<void> | null = null;

export function ensureBoot(): Promise<void> {
  if (booted) return Promise.resolve();
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    // Fast path: ingest jsonl into DB and start the watcher. Existing topics
    // in the DB are reused immediately so the UI renders without waiting for
    // LLM clustering. Topic rebuild + summary backfill run in the background.
    await fullScan({ rebuildTopics: false });
    startWatcher();
    booted = true;

    // Background work (fire-and-forget). Errors logged, never thrown back to
    // the UI. Summary backfill starts IMMEDIATELY (parallel to the long
    // rebuild) so the user doesn't wait 30+ min for new summaries.
    backfillSummaries();
    void (async () => {
      try {
        await rebuildAllTopics();
        // Re-enqueue any summaries that became available during rebuild.
        backfillSummaries();
      } catch (err) {
        console.error("background rebuild/backfill failed:", err);
      }
    })();
  })();
  return bootPromise;
}
