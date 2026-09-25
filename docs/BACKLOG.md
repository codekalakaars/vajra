# Backlog — remaining work

Completed work is removed from these docs; the code and its tests are the record.

**State:** all suites green — core 32 pass/1 skipped, protocol 11/11, sandbox
69/69, **CLI 292/292**, Rust 75/75. Builds, typechecks and clippy pass.
Committed on `feat/cli-agent-v1-config` at `5fb801b`; `main` is still at
`682fc8f` and does not yet carry this branch. The experimental packages
(`server`, `web`, `programmatic-video`) remain parked on the
`experimental-packages` branch at `bb732b2` — see "Regression bar" for what that
means for the server suite.

**The remaining substantial work is the worker pool (§1) plus the two open
hazards in [CONCURRENCY_HAZARDS.md](CONCURRENCY_HAZARDS.md) — concurrent shell
commands (P0) and lock-blocked tasks holding worker slots (P1).** Six of the
eight hazards are addressed; §3 below carries the two that are not. This file
holds everything else.

**Already done — do not redo:** per-task sandbox scoping, `search_content` +
`run_baseline`, the context-budget fix (coverage 7.5% → 42%), concurrent task
execution, the task-spec schema with `plan-validate.ts`, file-read caching,
persistence v1 **and v2 with resume + staleness gate**, the Manager
(`agent/master.ts`, `masterLoop`), **streaming visibility** (`AgentEvent`,
heartbeats, all three renderers), **parallel tool calls within a message**, the
TUI Defaults screen, and the `agent-core` move into `packages/`.

**Fixed in the hazard sweep — do not redo:** worker respawn on crash
(`launch.ts`), the parallel-safety guarantee actually consumed
(`plan-validate.ts`), validation-server port allocation (`tasks/server.ts`),
per-file hashing in `persist`, read-cache invalidation after `run_command`
(`handle.ts`), and a git re-read in the staleness gate (`session/resume.ts`).

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

This was previously marked "measure first" on throughput grounds, and that
reasoning still holds — one worker already serves concurrent calls, because the
IPC is `callId`-multiplexed and commands run through `runCommandAsync`. **The
argument that now justifies it is blast radius, not speed:** a single worker
still shares one process across every task, so an OOM or native fault can still
interrupt unrelated in-flight work before the replacement worker is ready. A
worker pool would provide per-task isolation and resource limits.

---

## 3 · Open hazards

Two of the eight in [CONCURRENCY_HAZARDS.md](CONCURRENCY_HAZARDS.md) are still
open. Both were re-checked against the code on 2026-09-26 and neither has a fix.

- **Concurrent shell commands contend on shared external state — P0.** Nothing
  serialises `run_command`: `master.ts:98` and `execute.ts:390` dispatch straight
  through, and `execute.ts:319` runs a tool-call group under `Promise.all`, so two
  commands can overlap *inside* one task as well as across tasks. Concurrent
  `pnpm install` corrupts `node_modules`; a second `git` command fails on
  `.git/index.lock`. A per-project command lock in the tool handle is the
  smallest fix; the plan schema actively encourages git in `rollback`.
- **Tasks blocked on locks occupy worker slots — P1.** A task is admitted, then
  blocks on `await fileLocks.acquireOrWait(...)` at `service.ts:683`, so it holds
  its slot while waiting. With `maxWorkers: 4`, four tasks contending for one
  path stall the pool. Admit only tasks whose locks are free, or release the slot
  while waiting.

## 2 · Small open items

- **Prompt caching is cancelled, not solved — and now measured.** `chat.ts`
  carries no `cache_control` (the OpenRouter removal took it), so nothing asks
  the gateway to cache. Measured on this repo: the resent prefix is **19,307
  chars ≈ 4,827 tokens** (10,280 summary + 9,027 tree), and a developer turn
  runs up to 60 iterations — roughly 290k prompt tokens per turn if the gateway
  caches nothing. What is *not* known is whether the zen gateway caches long
  prefixes implicitly. The experiment: two identical large requests, compare
  `usage.prompt_tokens` in the second against the first. That needs a live call
  against the configured key, so it is waiting on a decision to spend the credit
  rather than on more code.
