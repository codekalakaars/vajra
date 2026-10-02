# worker

One model loop per task attempt.

| File | What |
|------|------|
| `execute.ts` | `executeTask`: the loop, verification, attempt record |
| `pack.ts` | Builds the context pack the Worker starts from |
| `prompt.ts` | The two opening prompts: the legacy one and the pack one |
| `project-card.ts` | How the project builds and tests, read from its manifests |
| `output-cap.ts` | Caps one tool result (command output keeps its end, files their beginning) |
| `elide.ts` | Rung 1: rewrites stale tool results in place |
| `checkpoint.ts` | Rung 2: compacts the conversation into a checkpoint |
| `ledger.ts` | The runtime's record of what the Worker did (files written, commands, exit codes) |
| `diff.ts` | Diffs of what an attempt changed |
| `skip.ts`, `server.ts` | `skipIf` conditions; tasks whose validation needs a server |
| `context-types.ts` | The shapes the files above share |
