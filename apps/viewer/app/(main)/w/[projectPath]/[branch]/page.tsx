import { ChannelContent } from "@/components/ChannelContent";
import { ensureBoot } from "@/lib/bootstrap";
import { listTopicsForChannel, listSessionsForTopic } from "@/lib/db/queries";

export default async function ChannelPage({
  params
}: { params: Promise<{ projectPath: string; branch: string }> }) {
  await ensureBoot();
  const { projectPath: rawPath, branch: rawBranch } = await params;
  const projectPath = decodeURIComponent(rawPath);
  const branchRaw = decodeURIComponent(rawBranch);
  const branch = branchRaw === "(no branch)" ? null : branchRaw;

  const topics = listTopicsForChannel(projectPath, branch);
  const enriched = topics.map(t => ({ ...t, sessions: listSessionsForTopic(t.topic_id) }));

  return (
    <ChannelContent
      projectPath={projectPath}
      branch={branch}
      branchLabel={branchRaw}
      topics={enriched}
    />
  );
}
