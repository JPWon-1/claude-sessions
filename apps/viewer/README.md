# Claude Session Viewer

Local Slack-like UI for browsing past Claude Code sessions in `~/.claude/projects/`.

## Run

```bash
cd apps/viewer
pnpm install
pnpm dev
# open http://localhost:3000
```

## Notes
- Index lives at `~/.claude-viewer/index.db`. Delete it to rebuild from scratch.
- Summaries use the local `claude` CLI. If `claude` isn't on PATH, sessions get heuristic summaries (badge shown).
- First boot scan can take several seconds depending on how many projects are in `~/.claude/projects/`.

## Test

```bash
pnpm test
```
