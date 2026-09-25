# Backlog — remaining work

Completed work is removed from these docs; the code and its tests are the record.

**State:** all suites green — root 31 pass/1 skipped, protocol 11/11, sandbox
69/69, **CLI 272/272**. Every package typechecks. Everything is committed and
pushed: `main` is at `682fc8f`, and the experimental packages (`server`, `web`,
`programmatic-video`) are parked on the `experimental-packages` branch at
`bb732b2` — see "Regression bar" for what that means for the server suite.

**The substantial remaining work is [CONCURRENCY_HAZARDS.md](CONCURRENCY_HAZARDS.md)**
— eight hazards in the now-live parallel execution path, three of them P0. Start
there. This file holds everything else.

**Already done — do not redo:** per-task sandbox scoping, `search_content` +
`run_baseline`, the context-budget fix (coverage 7.5% → 42%), concurrent task
execution, the task-spec schema with `plan-validate.ts`, file-read caching,
persistence v1 **and v2 with resume + staleness gate**, the Manager
(`agent/master.ts`, `masterLoop`), **streaming visibility** (`AgentEvent`,
heartbeats, all three renderers), **parallel tool calls within a message**, the
TUI Defaults screen, and the `agent-core` move into `packages/`.

---

## Conventions

One agent owns a file; tests live in a file named after the module;
`npx tsc --noEmit` in every package touched; **do not commit**.

**Regression bar** — no suite below:

```
root 31 pass / 1 skipped / 0 fail   ·   protocol 11/11
sandbox 69/69   ·   CLI 272/272
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
means one crash fails every in-flight task at once, with no respawn. See
[CONCURRENCY_HAZARDS.md](CONCURRENCY_HAZARDS.md) §2, which also describes the
cheaper respawn-and-replay alternative worth trying first.

---

## 2 · Small open items

- **`deriveIndexBudget` saturates.** 128k, 200k and 256k context windows all
  return `MAX_INDEX_BUDGET_CHARS` (32,000) — verified. Model-awareness
  differentiates nothing among current models. Revisit once you know whether 42%
  coverage at ~19k chars of prompt is the right trade.
- **Two tests reach into `dist/` by path** — `test/summary-limits.test.mjs` and
  `test/context-budget.test.mjs`. They worked around a barrel that now exports
  the symbols they need, so they could import by package name.
- **Prompt caching is cancelled, not solved.** The OpenRouter removal took
  `cache_control` with it, and `chat.ts` has no caching. Every round-trip resends
  the full prefix — now ~19k chars of repo context, up from the ~3.5k measured
  before the coverage fix. If the zen gateway does not cache long prefixes
  server-side, that cost is being paid in full. Worth measuring before assuming
  it is free.
