# Backlog — remaining work

Completed work is removed from these docs; the code and its tests are the record.

**State:** all suites green — core 32 pass/1 skipped, protocol 11/11, sandbox
69/69, **CLI 292/292**, Rust 75/75. Builds, typechecks and clippy pass.
Committed on `feat/cli-agent-v1-config` at `5fb801b`; `main` is still at
`682fc8f` and does not yet carry this branch. The experimental packages
(`server`, `web`, `programmatic-video`) remain parked on the
`experimental-packages` branch at `bb732b2` — see "Regression bar" for what that
means for the server suite.

**The concurrency hazard sweep is complete — all eight hazards in
[CONCURRENCY_HAZARDS.md](CONCURRENCY_HAZARDS.md) are addressed, each with the
mechanism that holds.** The remaining substantial work is the worker pool (§1).
This file holds everything else.

**Already done — do not redo:** per-task sandbox scoping, `search_content` +
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

**Decided, do not re-litigate:** the index budget saturating at 32,000 chars for
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

## 1 · Worker pool

**Owns:** `packages/sandbox/src/pool.ts` *(new)*, `packages/sandbox/src/index.ts`,
`packages/cli/src/sandbox/launch.ts` · **Size:** L

Move `WorkerPool` from `experimental-packages/server/src/project/pool.ts` into
the sandbox package and use it from `launch.ts`. That file is no longer on
`main` — read it off the `experimental-packages` branch (`bb732b2`).

**Re-scoped 2026-09-26 — do not port it as written.** Two findings shrink this
considerably:

1. **The correctness property it was built for is already held here.** The pool's
   central rule is that a worker sandboxed for task A is never handed to task B.
   `sandbox.handleForTask(taskId, lookup, onMutate)` (`launch.ts:392`) already
   enforces exactly that per task, over one process. So the port is not about
   permissions at all.
2. **Crash recovery is already handled.** `launch.ts:275-296` respawns the worker
   on exit, bounded by `maxSpawnRetries`. What respawn does *not* do is isolate
   the blast radius: calls in flight on the dead worker still fail, so the tasks
   using it fail with them.

That leaves **one** real benefit: N workers, so a crash costs one task's calls
instead of every task's. Everything else the original pool carried — adaptive
concurrency from CPU/memory sampling, health-check pings, idle timers, worker
reuse keyed on a permission hash — is unused weight here, and the reuse key is
moot under per-task handles. Note also that hazard 1 now serialises
shared-resource commands, so a pool buys less command parallelism than it once
would have.

**Suggested shape:** a small `packages/sandbox/src/pool.ts` taking an injected
`launch: () => Promise<{ callTool, close }>` — no dependency on the CLI's
launcher — holding at most `maxWorkers` workers, replacing one whose process
exited, and handing each task a whole worker. Test it with injected fake workers
(no forking) and prove the isolation property directly: kill worker 1, assert
worker 2's in-flight call still resolves. Do not port the 473 lines.

---

## 2 · Small open items

- **Prompt caching: measured, and there is none.** Three identical ~19k-char
  requests to the zen gateway returned `prompt_tokens=4379` every time — a 0.0%
  change — so the full prefix is billed on every round-trip and the gateway does
  not discount long prefixes implicitly. `chat.ts` also carries no
  `cache_control`, so nothing asks it to. The resent prefix is **19,307 chars
  ≈ 4,827 tokens** (10,280 summary + 9,027 tree); a developer turn runs up to 60
  iterations, so a turn can cost roughly 290k prompt tokens.
  The remaining lever is shrinking the prefix, not caching it: the tree is 9,027
  of those 19,307 chars, and it already shrinks to fit its budget. If token cost
  ever matters more than coverage, cut the tree first — raising the index cap
  moves in the expensive direction.
