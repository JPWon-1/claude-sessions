import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { fullScan, rebuildAllTopics } from "@/lib/indexer/scan";
import { backfillSummaries } from "@/lib/summarizer/summarize";

export async function POST() {
  await ensureBoot();
  // Ingest is synchronous (cheap). Topic rebuild + summary backfill run in
  // the background so the user gets an immediate response. Summary backfill
  // kicks off immediately, in parallel with the slow LLM clustering.
  const result = await fullScan({ rebuildTopics: false });
  backfillSummaries();
  void (async () => {
    try {
      await rebuildAllTopics();
      backfillSummaries();
    } catch (err) {
      console.error("refresh background work failed:", err);
    }
  })();
  return NextResponse.json({ ok: true, ...result, rebuildingTopics: true });
}
