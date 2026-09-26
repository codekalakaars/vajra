# Backlog — remaining work

Completed work is removed from these docs; the code and its tests are the record.

**State:** all suites green — core 32 pass/1 skipped, protocol 11/11, sandbox
69/69, **CLI 292/292**, Rust 75/75. Builds, typechecks and clippy pass.
Committed on `feat/cli-agent-v1-config` at `5fb801b`; `main` is still at
`682fc8f` and does not yet carry this branch. The experimental packages
(`server`, `web`, `programmatic-video`) remain parked on the
`experimental-packages` branch at `bb732b2` — see "Regression bar" for what that
means for the server suite.

**The backlog is empty.** All eight hazards in
[CONCURRENCY_HAZARDS.md](CONCURRENCY_HAZARDS.md) are addressed, and the worker
pool has landed (`packages/sandbox/src/pool.ts`). Known gaps that are *not*
backlog items are listed at the end.

**Already done — do not redo:** **a per-task worker pool**
(`packages/sandbox/src/pool.ts`, `launchSandboxSessionPool`) so a crash costs one
task instead of every task, per-task sandbox scoping, `search_content` +
`run_baseline`, the context-budget fix (coverage 7.5% → 42%), concurrent task
execution, the task-spec schema with `plan-validate.ts`, file-read caching,
persistence v1 **and v2 with resume + staleness gate**, the Manager
(`agent/master.ts`, `masterLoop`), **streaming visibility** (`AgentEvent`,
heartbeats, all three renderers), **parallel tool calls within a message**, the
TUI Defaults screen, and the `agent-core` move into `packages/`.

**Fixed in the hazard sweep — do not redo:** `run_command` serialisation for
shared resources (`withCommandResourceLock`), worker respawn on crash
(`launch.ts`), the parallel-safety guarantee actually consumed
(`plan-validate.ts`), admission gated on lock availability (`canAdmitTask`),
validation-server port allocation (`tasks/server.ts`), per-file hashing in
`persist`, read-cache invalidation after `run_command` (`handle.ts`), and a git
re-read in the staleness gate (`session/resume.ts`).

**Decided, do not re-litigate:** there is no prompt caching. Three identical
~19k-char requests to the zen gateway all returned `prompt_tokens=4379` — 0.0%
change — so the full 19,307-char prefix (~4,827 tokens) is billed every
round-trip, up to ~290k prompt tokens per developer turn, and `chat.ts` sends no
`cache_control` either. The lever is shrinking the prefix, not caching it: the
tree is 9,027 of those chars and already shrinks to fit. Raising the index cap
therefore moves in the expensive direction.

The index budget saturating at 32,000 chars for
every window ≥128k. Measured on this repo after the experimental split: the whole
index renders in 10,280 chars — under a third of the cap — so a larger window
buys nothing today. `context-budget.test.mjs` now asserts the cap is not the
binding constraint and fails with a "revisit" message if the repo ever grows into
it. Raising the cap is a cost decision, not a correctness one: see the prompt
caching item below, which is why a bigger index is not free.

---

## Conventions

One agent owns a file; tests live in a file named after the module;
`npx tsc --noEmit` in every package touched. Work lands on a branch and reaches
`main` through a pull request — `main` is protected and rejects direct pushes.

**Regression bar** — no suite below:

```
core 32 pass / 1 skipped / 0 fail   ·   protocol 11/11
sandbox 69/69   ·   CLI 292/292   ·   Rust 75/75
```

The server suite (109 pass / 3 skipped) is no longer part of this bar: it lives
in `experimental-packages/server` on the `experimental-packages` branch. Run it
from a checkout of that branch, not from `main`.

Plus hand checks not covered by counts: `read_file` on a `.env` returns the
masked stub; `run_command` output is redacted; shell metacharacters rejected;
`cwd` escapes refused; masked files never surface through `search_files` or
`search_content`.

---

## Known gaps — deliberately not backlog items

Recorded so they are not rediscovered, not because they are scheduled.

- **Windows sandbox enforcement.** `applySandbox` refuses on Windows rather than
  pretending to confine; the CLI path is unenforced there. Closing this is a
  platform feature, not a cleanup.
- **Command serialisation is an allow-list.** `COMMAND_RESOURCE_PATHS` covers
  git, npm, npx, pnpm, yarn and cargo. A mutating command outside that set
  (`python`, `make`, `docker-compose`) is not serialised. Widening the map is
  cheap; a blanket per-directory lock was tried and reverted because it also
  serialises read-only commands.
