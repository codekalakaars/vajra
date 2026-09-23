# Vajra — parallel execution plan

Actionable tasks derived from [ISSUES.md](ISSUES.md). Every task cites its
finding (`§n`) — read that section for evidence and reproduction before starting.

Groups are **mutually exclusive by file**: no two groups in the same wave write
the same file. An agent may *read* anything; it may only *write* files listed
under its own group.

---

## Rules for agents

1. **Write only the files your group owns.** If a fix seems to need a file you
   don't own, stop and note it — it's either a shared contract (§ below) or a
   mis-scoped task.
2. **Tests go in a file named after your module** (`test/<module>.test.mjs`), so
   two groups never touch the same test file.
3. **Run `npx tsc --noEmit` in every package you touched** before finishing.
   `packages/cli` currently passes clean; keep it that way.
4. **One commit per task**, message prefixed with the task id (`B3: reject shell
   metacharacters in run_command`).
5. **Don't fix findings outside your group**, even obvious ones. Another agent
   owns them.
6. Commit only when asked — see repo convention.

---

## Shared contracts — agree before anyone starts

These six decisions are consumed by more than one group. They are already decided
below; do not renegotiate them mid-flight, or parallel work will not merge.

| # | Contract | Producer | Consumers |
| --- | --- | --- | --- |
| C1 | `run_command` **always** returns JSON `{ exitCode: number, signal: string \| null, stdout: string, stderr: string }` — never a bare string, even on success | B | C, L |
| C2 | `roleTools` in `packages/protocol/src/tools.ts` is the single role→tool table. `ROLE_DEFAULTS` in the sandbox is deleted | J | B, K |
| C3 | Planner tasks carry a **model-supplied `id`**; the CLI stops inventing `task-N` | J | E |
| C4 | The retry-count field is named **`retries`** everywhere. `maxRetries` is deleted | J | E |
| C5 | Task timeout field is renamed **`timeoutSeconds`**; the tool field stays `timeoutMs` | J | B, C |
| C6 | `streamChatCompletion` accepts an optional `signal: AbortSignal` as its last option | F | D |

---

## Wave map

```
WAVE 0   W0 ─────────────────────────────┐  (blocks B, C, D only)
         J, I, O, H, F, G, A run in parallel with W0 — different files
                                          │
WAVE 1   A  B  C  D  E  F  G  H  I  J  K  O   (+ L, M if the server stays)
                                          │
WAVE 2   Q (sandbox wiring)  N (agent-core adoption)
```

**Wave 0 is one agent, ~1 hour, zero behaviour change.** Everything else in
Wave 1 that doesn't touch `run.ts` can start immediately alongside it.

---

## D0 — Decision required (human, blocks Q)

**§2.** Is the CLI the product, or is `experimental-packages/server` coming back?

- If **CLI**: Group Q (wire the sandbox into `vajra run`) is mandatory, and
  Groups L/M are optional cleanup.
- If **server**: Groups L/M become mandatory and Q is deferred.
- Either way README's status table currently describes Path B while users run
  Path A — Group O fixes the text once this is answered.

Nothing else blocks on this.

---

# WAVE 0

## W0 — Decompose `run.ts` (1 agent, serial, blocks B/C/D)

**Owns:** `packages/cli/src/run.ts` → creates `packages/cli/src/tasks/*.ts`,
`packages/cli/src/tools/handle.ts`

Pure code movement. **No behaviour change, no bug fixes** — the fixes land in
Waves 1 on the extracted files. Split points are already clean top-level
functions:

| Move | From `run.ts` | To |
| --- | --- | --- |
| `evaluateSkipIf` | :27–57 | `src/tasks/skip.ts` |
| `SERVER_REQUIRED_PATTERNS`, `needsServer`, `findServerEntry` | :59–90 | `src/tasks/server.ts` |
| `computeTaskPermissions` | :92–134 | `src/tasks/permissions.ts` |
| `executeTask` | :136–269 | `src/tasks/execute.ts` |
| `dummyHandle` object | :305–368 | `src/tools/handle.ts`, exported as `createToolHandle(projectDir)` |

`runCommand` (:271+) stays in `run.ts` as orchestration only.

**Done when:** `npx tsc --noEmit` clean; `git diff` shows only moves plus
import/export lines; `node dist/index.js run --help` still prints help.

---

# WAVE 1

## Group A — Project index & secret exposure

**Owns:** `packages/cli/src/native.ts`, `packages/cli/src/agent/summary.ts`,
`packages/cli/test/summary.test.mjs`
**Depends on:** nothing · **Size:** S

| # | § | Change |
| --- | --- | --- |
| A1 | §1 | `shouldSkipFile` (`summary.ts:59`): return `true` when `entry.isMasked`. `scanProject` already delivers the correct flag (`developer.ts:366` → `buildSummaryIndex`), so this is the one-line fix that stops `.env` reaching the model. |
| A2 | §1 | `listFiles` wrapper (`native.ts:33`): stop hardcoding `isMasked: false`. Native `FileEntry` has no masking flag, so derive it from the basename with the same rule as `permissions.rs:51` (`.env`, `.env.local`) — export an `isMaskedName(name)` helper from `native.ts`. |
| A3 | §29 | `shouldSkipFile`: consult `SKIP_DIRS`, which is declared at `:5` and never used. Port the exact line from `experimental-packages/server/src/agent/summary.ts:81`. |
| A4 | §29 | `SKIP_EXTENSIONS`: `.min.js`/`.min.css` can never match because the extension is the last dot-segment (`:61`). Match multi-dot suffixes with `endsWith`. |
| A5 | §29 | `searchSummary` (`:186`): requiring **every** term to appear makes most queries return nothing, which feeds the infinite loop in E4. Rank by match count instead; return the top 15. |
| A6 | §13 | Rename the `includeHidden` parameter to `recursive` (`native.ts:27`) — native's signature is `listFiles(path, recursive?)` (`index.d.ts:55`) and the name says the opposite of what it does. |

**Done when:** `test/summary.test.mjs` asserts a `.env` fixture never appears in
`buildSummaryIndex` output nor in `searchSummary` results, and that a `dist/`
path is excluded.

---

## Group B — Tool handle: permissions & command execution

**Owns:** `packages/cli/src/tools/handle.ts`, `packages/cli/src/tasks/permissions.ts`,
`packages/cli/test/handle.test.mjs`
**Depends on:** W0, and C2 for B9 · **Size:** L

| # | § | Change |
| --- | --- | --- |
| B1 | §1 | Gate `read_file` on the resolved permission. The developer agent's handle currently calls native `readFile` with no check at all. A masked path must return a redacted stub, never bytes. |
| B2 | §3 | Apply `redact()` from vajra-core (`index.d.ts:146`) to `run_command` stdout/stderr and file reads, seeded from the project's parsed `.env`. It has **zero** call sites today. |
| B3 | §20 | Replace `command.split(/\s+/)` with a quote-aware tokenizer. Reject `&&`, `\|`, `>`, `;`, backticks and `$(` with an explicit error telling the model to issue separate calls — don't silently pass them as argv. |
| B4 | §21 | Resolve `cwd` against `projectDir` (not `process.cwd()`) and reject paths that escape it. |
| B5 | §19 | Treat `signal != null` as failure. Emit the C1 shape on **every** path, success included. |
| B6 | §12 | Replace the hand-rolled `spawn` with `native.runCommandAsync(cmd, args, cwd)` — it already reports `code: -1` on signal, which is exactly the bug B5 works around. Keep a timeout wrapper around it. |
| B7 | §13 | Pass the model's `recursive` argument through to `list_files`; it is currently dropped. |
| B8 | §6 | `computeTaskPermissions`: normalise paths (resolve against projectDir, posix separators) on both write and lookup, so `./src/a.ts` and `src/a.ts` match. |
| B9 | §10 | Implement a `search_files` case (delegate to the session's summary index). Today it falls through to `"Unknown tool: search_files"` returned as a **successful** result. Per C2, J keeps it in `roleTools.worker` on the assumption you implement it — coordinate if you decide otherwise. |
| B10 | §10 | Add `delete_file` and `create_dir` cases. Plans can declare `deleteFile`/`createDir` and permissions grant `delete`, but no tool exists, so `type: 'delete'` tasks cannot execute. |

**Done when:** `test/handle.test.mjs` covers: masked read returns a stub;
`echo a && rm -rf /` is rejected; a signal-killed command reports failure;
`cwd: '../..'` is refused.

---

## Group C — Task execution & validation

**Owns:** `packages/cli/src/tasks/execute.ts`, `packages/cli/src/tasks/skip.ts`,
`packages/cli/src/tasks/server.ts`, `packages/cli/test/execute.test.mjs`,
`packages/cli/test/skip.test.mjs`
**Depends on:** W0, C1, C5 · **Size:** M

| # | § | Change |
| --- | --- | --- |
| C1t | §18 | Convert seconds → ms at the `run_command` call site (`execute.ts`, was `run.ts:239`). A default task currently kills every validation command after **120 ms**. Use the C5 field name. |
| C2t | §19 | Validation fails on non-zero exit **or** signal. Parse the C1 shape; delete the `exitCode = 0` fallback that currently makes a force-killed command pass. |
| C3t | §25 | `evaluateSkipIf`: an unrecognised condition must **not** skip (it currently returns `true` → skip) — warn and continue. Implement `command passes:`, which the protocol already advertises (`tools.ts:~272`). |
| C4t | §12 | The validation server is spawned `detached: true` but killed with `serverProcess.kill()`, which misses the process group — use `process.kill(-pid)`. Also consume its piped stdout so the buffer can't fill and stall it. |

**Done when:** `test/skip.test.mjs` asserts unknown conditions don't skip;
`test/execute.test.mjs` asserts a 124-exit (timeout) command fails validation.

---

## Group D — Session orchestration

**Owns:** `packages/cli/src/run.ts`, `packages/cli/src/streaming.ts`,
`packages/cli/test/report.test.mjs`
**Depends on:** W0, C6 (for D6) · **Size:** L

| # | § | Change |
| --- | --- | --- |
| D1 | §4 | `new ChangeHistory(projectDir)` — passing no project dir disables the class's own path-escape guard, so rollback writes and `unlink`s **cwd-relative** paths. Also replace the two raw `options.projectDir` uses (`:480`, `:531`) with the resolved one. |
| D2 | §5 | Track "the worker actually wrote something" separately from "baseline recorded" (a dirty-set fed by the tool handle). Re-record the baseline after each rollback. Today `maxRetries: 2` behaves as 1 **and** the final attempt's edits are left on disk while the task reports `Failed`. |
| D3 | §17 | Wire `options.timeout` into the queue as the per-task default. `-t 600` currently changes nothing but the banner. |
| D4 | §26 | Use `fileLocks.acquireOrWait` (`file-locks.ts:117`) instead of permanently skipping a task on lock conflict. |
| D5 | §27 | Count `pending` in the final report and exit non-zero when anything is pending or failed. Tasks with unresolvable dependencies currently vanish and the user sees "✅ Done!". |
| D6 | §37 | Second SIGINT → `process.exit(130)`. Thread an `AbortSignal` (C6) into the provider so the first one actually interrupts a stalled stream. |
| D7 | §38 | Handle `exit`/`quit` at the **first** prompt — the check only exists in the retry loop, so typing `exit` starts a session with the task "exit". |
| D8 | §39 | `[y/N]` prompt requiring an affirmative (bare Enter currently approves). Extend `planSummary` (`streaming.ts:67`) to print each task's `writeFile` targets and validation commands — the user currently approves file-modifying work seeing only titles. |
| D9 | §45 | Fix the 20-turn message: it claims execution is starting; the function returns immediately after. |

**Done when:** `test/report.test.mjs` covers the status tally; Ctrl-C twice exits
during a prompt and during a stream.

---

## Group E — Planner & task queue

**Owns:** `packages/cli/src/agent/developer.ts`, `packages/cli/src/agent/taskqueue.ts`,
`packages/cli/test/plan.test.mjs`, `packages/cli/test/compress.test.mjs`
**Depends on:** J1 (C3), J6 (C4) · **Size:** M

| # | § | Change |
| --- | --- | --- |
| E1 | §22 | Use the model-supplied `id` (C3) instead of inventing `task-${i+1}`. Validate uniqueness. When `dependsOn` references an unknown id, **return a tool error** so the model can correct it — today `filter(dep => taskIds.has(dep))` silently deletes every declared dependency. |
| E2 | §15 | Write `retries`, not the phantom `maxRetries` (C4), and make `taskqueue.ts:74` read the same name. `retries: 0` from a planner currently becomes 2. |
| E3 | §15 | Use the protocol's `validationStrategy` union; drop the invented `'targeted' \| 'full' \| 'skip'` values and the cast that hides them (`:227`). |
| E4 | §23 | Bound the developer loop by wall-clock and total iterations, not only paid tool calls. `search_files` is in `FREE_TOOLS` and never increments the counter, so a model that keeps calling it loops **forever**, one paid request per iteration. |
| E5 | §24 | `compressMessages`: assemble in complete assistant+tool-result units. It currently drops orphaned tool results but can still emit an assistant `tool_calls` message whose results were skipped — a provider 400 that surfaces as "Check your API key". |

**Done when:** `test/plan.test.mjs` asserts dependencies survive a round-trip and
an unknown id produces an error; `test/compress.test.mjs` asserts no compressed
output ever has an unanswered `tool_call_id`.

---

## Group F — Provider transport

**Owns:** `packages/cli/src/agent/openrouter.ts`, `packages/cli/test/openrouter.test.mjs`
**Depends on:** nothing · **Produces:** C6 · **Size:** M

| # | § | Change |
| --- | --- | --- |
| F1 | §28 | Accept `signal?: AbortSignal` on `ChatCompletionRequest` and pass it to the SDK (C6). |
| F2 | §28 | Per-request timeout (suggest 120 s). There is none today, so a stalled stream hangs the CLI indefinitely. |
| F3 | §28 | Real exponential backoff. `retryAfterMs` reads `err.headers?.['retry-after']` but the SDK exposes a `Headers` object, so it always falls back to a flat 1 s × 5. |
| F4 | §28 | Don't re-emit already-streamed text on retry — a mid-stream 429 currently prints the answer twice. |
| F5 | §28 | Retry `ECONNRESET`/`ETIMEDOUT`, the common failure mode for long streams. |

**Done when:** `test/openrouter.test.mjs` drives a stub client through 429 →
success and asserts single emission plus growing delays.

---

## Group G — Entry point, config, TUI

**Owns:** `packages/cli/src/index.ts`, `packages/cli/src/env.ts`,
`packages/cli/src/tui/index.tsx`, `packages/cli/test/env.test.mjs`
**Depends on:** nothing · **Size:** S

| # | § | Change |
| --- | --- | --- |
| G1 | §16 | Fix `--set`. Commander takes one argument per option, so `-s KEY VALUE` currently writes `O=P E N R O U T E R _ A P I _ K E Y`. Use `<key=value>` or two positionals, and update the help text at `:137`. |
| G2 | §41 | Call `findEnvPath()` (`env.ts:38`) in both places — it exists and is never used; `index.ts` hardcodes `resolve(rootDir, '.env')` at `:19` and `:71`, which points into `node_modules/` for a global install. Make the cwd `.env` take precedence. |
| G3 | §43 | Read `DEFAULT_MODEL`/`VAJRA_MODEL` from the environment in both `index.ts:36` and `startTUI` (`tui/index.tsx:270`). `vajra config` advertises both keys and nothing reads them. |
| G4 | — | Read the version from `package.json` instead of the three hardcoded `'0.0.1'` literals. |

**Done when:** `test/env.test.mjs` covers `writeEnvKey`/`findEnvPath`;
`vajra config -s FOO bar && vajra config -g FOO` round-trips.

---

## Group H — Video subcommands

**Owns:** `packages/cli/src/video.ts`, `packages/cli/test/video.test.mjs`
**Depends on:** nothing · **Size:** S

| # | § | Change |
| --- | --- | --- |
| H1 | §44 | Check `response.ok` and validate `items` is an array before `.filter` — a 404 currently throws `Cannot read properties of undefined`. |
| H2 | §44 | Windows: `execFileSync('npx')` can't find `npx.cmd`. Use the platform-correct binary or `shell: true`. README claims Windows support. |
| H3 | — | Validate `--fps` is numeric before forwarding it. |

---

## Group I — Packaging

**Owns:** `packages/cli/package.json`, `packages/sandbox/package.json`,
`packages/protocol/package.json`, `packages/sandbox/src/cli.ts`
**Depends on:** nothing · **Size:** S — **highest value per line in the plan**

| # | § | Change |
| --- | --- | --- |
| I1 | §31 | `packages/sandbox/src/cli.ts:22`: `require('vajra-core')` → `require('@codekalakaars/vajra-core')`. Top-level require, so this one line kills **every** `vajra secure`/`status`/`config`/`test` subcommand and 11 of 69 sandbox tests. |
| I2 | §32 | Rename the sandbox `bin` from `vajra` to `vajra-sandbox`. Both packages claim `vajra`; inside `packages/cli` the name already resolves to the sandbox CLI. |
| I3 | §33 | Remove `private: true` from `packages/protocol`, or bundle it. Two publishable packages have a hard runtime dependency on it, so `npm i -g @codekalakaars/vajra-cli` can't resolve. |
| I4 | §34 | Add `"files": ["dist"]` to the CLI and a clean step to its build script — `tsc` doesn't prune `outDir`, so the stale `dist/agent/manager.js` (no source file) ships. |
| I5 | §40 | `engines.node` says `>=18`; `ink@7.1.1` requires `>=22`, and the TUI is the default entry point. Raise the floor or pin ink. |
| I6 | — | Add `"test": "node --test \"test/*.test.mjs\""` so the other groups' tests actually run under `pnpm -r test`. |

**Done when:** `pnpm --filter @codekalakaars/vajra-sandbox test` is green;
`pnpm -r test` picks up the CLI suite.

---

## Group J — Protocol contracts

**Owns:** `packages/protocol/src/tools.ts`, `packages/protocol/src/messages.ts`,
`packages/protocol/src/rpc.ts`, `packages/protocol/test/tools.test.mjs`
**Depends on:** nothing · **Produces:** C2, C3, C4, C5 · **Size:** M
**Start this early** — E, B and K consume its output.

| # | § | Change |
| --- | --- | --- |
| J1 | §22 | Add a required `id: string` to the `propose_plan` task schema **and** jsonSchema, described so the model knows to reference it from `dependsOn`. There is currently no id field at all, which is why every dependency is dropped. (Produces C3.) |
| J2 | §11 | Make `deleteFile`, `createDir`, `validation`, `instructions`, `readFile`, `writeFile` optional with `[]` defaults in zod, and drop them from jsonSchema `required`. Verified: a normal plan fails `safeParse` with `deleteFile: Required`. |
| J3 | §42 | Update the stale example in `test/tools.test.mjs` — it still uses a `files: [...]` field and a string `validation`. Get the suite green. |
| J4 | §18 | Disambiguate units: rename the task field to `timeoutSeconds`, keep the tool field as milliseconds, fix both descriptions. (Produces C5.) |
| J5 | §14 | Make `roleTools` canonical and consistent with what the dispatchers implement. (Produces C2 — K deletes its rival table.) |
| J6 | §15 | Keep `retries`; make sure no `maxRetries` appears anywhere in the protocol. (Produces C4.) |
| J7 | §8 | Add an `RpcMethods` map (method → `{params, result}`) as the single source of truth, and correct `SessionCreateResult`/`SessionAttachResult` to what the server actually returns (`projectId`, `project`). Three shapes currently disagree. |
| J8 | §10 | Either delete the `nativeFn` field or make it the real dispatch key — no dispatcher reads it, and `search_files`'s value (`searchSummary`) names a function vajra-core doesn't export. |

**Done when:** `packages/protocol` suite green and `tsc --noEmit` clean in every
dependent package.

---

## Group K — Sandbox package

**Owns:** `packages/sandbox/src/sandbox-builder.ts`, `tool-rules.ts`, `index.ts`,
`daemon.ts`, `client.ts`
**Depends on:** J5 (C2), I1 to see tests pass · **Size:** S

| # | § | Change |
| --- | --- | --- |
| K1 | §7 | Carry `readExecutePaths`/`readWritePaths` from `SandboxConfig` through `LaunchJob` (`sandbox-builder.ts:123–167`). They're accepted by the config and by native `applySandbox`, and silently dropped in between — so allowlisting a toolchain does nothing and `run_command` fails on the interpreters the user permitted. |
| K2 | §14 | Delete `ROLE_DEFAULTS` (`tool-rules.ts:179`); import `roleTools` from the protocol (C2). The two tables disagree, and the sandbox's version would deny the developer's `propose_plan`. |
| K3 | §30 | `daemon.ts` (288 lines) and `client.ts` (135) are not exported from `index.ts` and have no importers; `SandboxClient` also has a single `pendingResolve` slot with no request-id correlation. Delete both, or export them and add correlation. Recommend delete. |

---

## Group O — Docs & repo scripts

**Owns:** `README.md`, root `package.json`
**Depends on:** D0 for the wording · **Size:** S

| # | § | Change |
| --- | --- | --- |
| O1 | §2 | The status table claims Landlock/Seatbelt enforcement; the CLI never calls `applySandbox`. State which path is enforced, or mark the CLI unconfined until Group Q lands. |
| O2 | §35 | Document that `*.node` is gitignored while the generated loader is committed — a fresh clone needs `pnpm build` (Rust toolchain) before the CLI can import vajra-core at all. |
| O3 | §36 | Root `dev` script starts `vajra-server` + `vajra-web`, both now in `experimental-packages/`. Add a script that builds and runs the CLI. |

---

## Groups L & M — server path *(only if D0 says the server stays)*

### Group L — Sandboxed worker
**Owns:** `experimental-packages/server/worker/sandboxed-worker.mjs`,
`experimental-packages/server/src/project/manager.ts` · **Depends on:** K1, J8

| # | § | Change |
| --- | --- | --- |
| L1 | §7 | Always call `checkToolPermission`. The `if (fileRules.length > 0)` guard (`:110`) means a config with no rules skips enforcement entirely, including its own `defaultFilePermissions`. |
| L2 | §10 | `native.searchSummary` does not exist — implement it or drop the tool. |
| L3 | §12 | Replace `execSync` (a **full shell**, in the security boundary, contradicting the protocol's own header comment) with `native.runCommandAsync`. It's also synchronous, which is why the `maxCpuTimeMs` watchdog can never fire. |
| L4 | §7 | Forward `readExecutePaths` into `applySandbox` once K1 lands. |

### Group M — Server/web RPC conformance
**Owns:** `experimental-packages/server/src/ws/**`, `experimental-packages/web/src/**`
· **Depends on:** J7

| # | § | Change |
| --- | --- | --- |
| M1 | §8 | Type `RpcRouter.register` and the web's `call` from the protocol's `RpcMethods`; delete the `getProjectId` `projectId ?? sessionId` fallback that hides the drift. |
| M2 | §9 | Surface `projects.sandboxStatus` in the UI — the web has zero occurrences of "sandbox", so the user is never told whether the session is confined. Wire the `allowUnenforced` confirmation the protocol comment requires. |

---

# WAVE 2

## Group Q — Wire the sandbox into the CLI
**Owns:** `packages/cli/src/run.ts` (after D), new `packages/cli/src/sandbox/launch.ts`
**Depends on:** D0 = "CLI", Group D, K1 · **Size:** L

**§2.** Fork a confined worker for tool execution instead of running tools
in-process: build a `SandboxConfig`, call `buildLaunchJob`, fork a worker that
calls `applySandbox` before touching anything, and route the handle's tool calls
over IPC. `experimental-packages/server/worker/sandboxed-worker.mjs` is the
working reference — with L1/L3 applied.

This is the finding that decides whether the product does what the README says.

## Group N — Adopt `agent-core`
**Owns:** `experimental-packages/agent-core/src/**`, `packages/cli/src/agent/**`
**Depends on:** A, E · **Size:** M

**§30.** `summary.ts`, `tree.ts` and `tools.ts` exist in three copies. `tree.ts`
is byte-identical between CLI and server; `summary.ts` differs by 155 lines.
`agent-core` exists for exactly this and has **no dependents**.

Move the (now fixed) CLI versions into `agent-core`, have `packages/cli` and the
server depend on it, delete the copies. Sequenced after A and E so the fixes
aren't written twice — the `SKIP_DIRS` bug (§29) is already fixed in the other
two copies and not in the CLI's, which is what this group exists to prevent
recurring.

---

## File ownership index

Check here before writing anything.

| File | Group |
| --- | --- |
| `packages/cli/src/native.ts` | A |
| `packages/cli/src/agent/summary.ts` | A → N |
| `packages/cli/src/tools/handle.ts` | W0 → B |
| `packages/cli/src/tasks/permissions.ts` | W0 → B |
| `packages/cli/src/tasks/execute.ts` · `skip.ts` · `server.ts` | W0 → C |
| `packages/cli/src/run.ts` | W0 → D → Q |
| `packages/cli/src/streaming.ts` | D |
| `packages/cli/src/agent/developer.ts` · `taskqueue.ts` | E → N |
| `packages/cli/src/agent/openrouter.ts` | F |
| `packages/cli/src/index.ts` · `env.ts` · `tui/index.tsx` | G |
| `packages/cli/src/video.ts` | H |
| `packages/cli/package.json` | I |
| `packages/protocol/src/**` · `test/**` | J |
| `packages/protocol/package.json` | I |
| `packages/sandbox/src/cli.ts` · `package.json` | I |
| `packages/sandbox/src/sandbox-builder.ts` · `tool-rules.ts` · `index.ts` · `daemon.ts` · `client.ts` | K |
| `experimental-packages/server/worker/**` · `src/project/manager.ts` | L |
| `experimental-packages/server/src/ws/**` · `experimental-packages/web/src/**` | M |
| `experimental-packages/agent-core/src/**` | N |
| `README.md` · root `package.json` | O |

Unlisted files are unowned — claim one by adding it here in the same commit.
