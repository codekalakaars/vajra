# Vajra — issues report

Review of the whole workspace at commit `6660127`, branch `feat/master-agent`:
`packages/core` (Rust napi addon), `packages/protocol`, `packages/sandbox`,
`packages/cli`, and the `experimental-packages/*` tree they interoperate with.

Everything below is a behavioural defect, not a style preference.
**[verified]** marks findings reproduced by running the code; the rest are read
from source with the exact call path cited.

`tsc --noEmit` passes clean in every package, so none of these are type errors —
they are runtime, contract, and packaging problems.

> **Fixing these?** See [TASKS.md](TASKS.md) — the same findings as actionable
> tasks, grouped by file ownership so multiple agents can work in parallel
> without conflicting. This document stays the evidence; TASKS.md is the plan.

---

## Contents

- [Part I — How the packages actually fit together](#part-i--how-the-packages-actually-fit-together)
- [Part II — P0: secrets, enforcement, data loss](#part-ii--p0-secrets-enforcement-data-loss) (§1–§7)
- [Part III — Contracts that don't match across the seams](#part-iii--contracts-that-dont-match-across-the-seams) (§8–§15)
- [Part IV — CLI commands that don't do what they say](#part-iv--cli-commands-that-dont-do-what-they-say) (§16–§21)
- [Part V — Planning and agent-loop correctness](#part-v--planning-and-agent-loop-correctness) (§22–§29)
- [Part VI — Duplication and drift](#part-vi--duplication-and-drift) (§30)
- [Part VII — Packaging, tests, UX](#part-vii--packaging-tests-ux) (§31–§45)
- [Part VIII — Root cause and suggested sequence](#part-viii--root-cause-and-suggested-sequence)

---

## Part I — How the packages actually fit together

There are two end-to-end paths in this repo, and they share almost nothing.

**Path A — the CLI (the shipping product):**

```
vajra run
  └─ packages/cli/src/run.ts
       ├─ scanProject()             → root index.js → vajra-core.node  (Rust)
       ├─ buildSummaryIndex()       → packages/cli/src/agent/summary.ts  (own copy)
       ├─ developerConversationTurn → openrouter.ts → OpenRouter HTTP
       ├─ getDeveloperToolSpecs()   → packages/protocol roleTools
       └─ dummyHandle.callTool()    → inline switch in run.ts
            ├─ read/write/edit      → vajra-core
            └─ run_command          → node:child_process.spawn  (hand-rolled)
```

**Path B — the server (`experimental-packages/server`):**

```
ws projects.create
  └─ project/manager.ts
       ├─ loadSandboxConfig() → buildLaunchJob()    → packages/sandbox
       └─ launcher.ts → fork(worker/sandboxed-worker.mjs)
            ├─ native.applySandbox()                → Landlock / Seatbelt
            ├─ checkToolPermission()                → packages/sandbox
            └─ dispatchTable                        → vajra-core + execSync
```

**Path A never touches `applySandbox`, `checkToolPermission`,
`createSandboxConfig`, `buildLaunchJob`, `resolveAllowedTools`, `redact`, or
`createWorktree`.** Grep confirms: `packages/cli` imports exactly three symbols
from `@codekalakaars/vajra-sandbox` — `FileLockManager`, `ChangeHistory`, and an
unused `ResourceLimits` type (`run.ts:10`).

The last commit, which moved `server` into `experimental-packages`, demoted the
*only* code path that enforces anything. Every security mechanism the README
advertises lives on Path B.

---

## Part II — P0: secrets, enforcement, data loss

### §1. `.env` contents are handed to the LLM **[verified]**

The masking chain works at every layer except the one that ships:

| Layer | Behaviour |
| --- | --- |
| `packages/core/src/permissions.rs:51`,`:139` | flags `.env` / `.env.local` with `is_masked: true` |
| `packages/protocol/src/messages.ts:22` | carries `isMasked` on `ProjectFileEntry` |
| `web/src/components/NewProjectModal.tsx:191` | `map[f.path] = f.isMasked ? false : …` — turns it into `read: false` |
| **`packages/cli/src/native.ts:33`** | **hardcodes `isMasked: false`** |
| `packages/cli/src/agent/summary.ts:59` | `shouldSkipFile` never checks it, so `readFileSync` runs on `.env` (`:75`) and the first 150 chars go into `preview` |
| `packages/cli/src/agent/summary.ts:197` | `searchSummary` returns that preview verbatim to the model |

Turning `isMasked` into a permission is a **web-UI-only** behaviour. The CLI has
no equivalent step and couldn't have one — the flag is destroyed at the boundary.

Reproduced against `dist/`:

```
--- search for "env" ---
.env [3L]
  Symbols: (no symbols)
  Preview: OPENROUTER_API_KEY=sk-or-v1-SUPERSECRET123 DB_PASSWORD=hunter2
```

`search_files` is the tool the developer agent is explicitly told to use. Worse,
the developer's handle is `dummyHandle` (`run.ts:305`), whose `read_file` case
(`run.ts:309`) calls native `readFile` with **no permission check at all** —
`read_file('.env')` just works.

This is the one thing the product exists to prevent, and it happens without the
model doing anything adversarial.

**Fix:** propagate `isMasked` through `native.ts`; skip masked entries in
`buildSummaryIndex`; gate `dummyHandle.read_file` on `permissionsFor`/`redact`
from vajra-core. A masked file should return a redacted stub, never its bytes.

### §2. The sandbox is never applied on the CLI path

`applySandbox` has exactly one caller in the repo:
`experimental-packages/server/worker/sandboxed-worker.mjs:180`. That file's
header says *"The only file in this package that calls applySandbox"* —
accurate, and the file now lives in the experimental tree.

Consequences for `vajra run`:

- No Landlock/Seatbelt confinement. The agent has the user's full filesystem.
- No `checkToolPermission`. The CLI substitutes `computeTaskPermissions`
  (`run.ts:92`), an exact-string-match map that `run_command` bypasses entirely
  (§6).
- No `.env` masking (§1).

README.md's status table says "Sandbox enforcement | Linux (Landlock) and macOS
(Seatbelt)". For the CLI that is not true. Either wire `buildLaunchJob` plus a
forked confined worker into `run.ts`, or change the table.

### §3. `redact` has zero callers

`redact` / `minRedactableLength` are implemented in Rust
(`packages/core/src/secret.rs`), exported (`index.d.ts:146`), documented in the
README, and covered by `test/security.test.mjs`. Grep across every `.ts`, `.tsx`
and `.mjs` outside `node_modules`: **no production call site.**

Nothing filters secrets out of command stdout, file reads, or tool results
before they are streamed to the model provider.

### §4. Rollback resolves paths against the wrong directory

`run.ts:297` constructs `new ChangeHistory()` with **no `projectDir`**. With no
project dir, `ChangeHistory.resolvePath` returns the path unchanged
(`packages/sandbox/src/change-history.ts:39`) and the "must stay inside the
project root" guard (`:43`) is disabled.

With `vajra run -d /some/other/project`:

- `recordBefore` reads `src/foo.ts` relative to the CLI's `process.cwd()`, so
  the recorded "original content" is the wrong file's, or `null`.
- `rollback` then **writes that content to a cwd-relative path**
  (`change-history.ts:114`) or `unlink`s one (`:108`) for every entry recorded as
  `null`.

**Fix:** `new ChangeHistory(projectDir)` — the class already implements the
guard. Also pass the resolved `projectDir`, not the raw `options.projectDir`
used at `run.ts:480` and `run.ts:531`.

### §5. Retries are capped at one, and the last attempt is never rolled back

`run.ts:522` calls `recordBefore` for every file in the task *before* execution,
so `changeHistory.hasChanges(task.id)` is true whether or not the worker touched
anything. Then in the retry loop (`run.ts:530-548`):

1. Attempt 1 fails → `hasChanges` true → `rollback()` runs, and rollback
   **deletes the task's baseline** (`change-history.ts:123`) → `retries = 1`.
2. Attempt 2 fails → `hasChanges` is now false → the "No changes made - skipping
   retry" branch (`run.ts:536`) fires and breaks out.
3. `if (changeHistory.hasChanges(task.id))` at `run.ts:555` is also false, so
   **attempt 2's edits stay on disk** while the task is reported as `Failed`.

`maxRetries: 2` behaves as 1, the "no changes" guard is dead code in its intended
sense, and a failed task leaves half-applied edits behind.

**Fix:** track "the worker actually wrote something" separately from "baseline
recorded", and re-record the baseline after each rollback.

### §6. Worker file permissions are advisory only

`taskHandle` (`run.ts:505`) checks `permissions[a.path]` by **exact string
match** against the paths the planner listed:

- A worker reading `./src/foo.ts` or an absolute path for a file it legitimately
  owns gets `Access denied`.
- `run_command` isn't checked at all, and its allowlist (`run.ts:324-332`)
  includes `cat`, `grep`, `find`, `curl`, `wget`, `rm`, `chmod`. `cat .env` and
  `rm -rf src` both sail past the permission layer.

Given SECURITY.md's threat model this isn't "the sandbox is broken", but the
per-file permission feature doesn't hold against *accidental* access either,
which is the case it's advertised for.

### §7. Tool-layer file rules are skipped whenever no config file exists

On Path B, `manager.ts:190-196`: with no `.vajra-sandbox.json`, `fileRules` stays
`undefined`. The worker then does:

```js
if (fileRules.length > 0) {                      // sandboxed-worker.mjs:110
  const denied = checkToolPermission(...)
}
```

With no rules the check is skipped entirely — including
`defaultFilePermissions`, the one thing that *was* configured. A default
`createSandboxConfig({ projectDir })` produces `fileRules: []`, so its
`{read: true, write: false, edit: false, delete: false}` is silently unenforced
at the tool layer.

**Fix:** always call `checkToolPermission`; an empty rule list should mean
"fall through to `defaultFilePermissions`", not "allow".

Related: `readExecutePaths` / `readWritePaths` are accepted by `SandboxConfig`
(`config.ts:33-35`) and by native `applySandbox` (`index.d.ts:131-137`) — they're
how you grant the sandbox access to `node`, `cargo`, `tsc` — but
`buildLaunchJob` never copies them into the `LaunchJob`
(`sandbox-builder.ts:158-167`), `LaunchJob` has no field for them (`:123-139`),
and the worker passes only `projectDir`/`permissions`/`allowUnenforced` to
`applySandbox` (`sandboxed-worker.mjs:180-184`). Configuring a toolchain path
does nothing, and `run_command` inside the sandbox then fails on exactly the
interpreters the user allowlisted.

---

## Part III — Contracts that don't match across the seams

### §8. `packages/protocol` is not the contract; it's a suggestion

Three shapes for the same call:

| | `projects.create` result | `projects.attach` result |
| --- | --- | --- |
| **protocol** `messages.ts:125`,`:153` | `{ sessionId }` | `{ session, sandbox, messages }` |
| **server** `manager.ts:243`,`:368` | `{ projectId }` | `{ project, sandbox, messages }` |
| **web** `lib/rpc.ts:14`,`:15` | `{ projectId }` | `{ project, plan, messages }` |

The protocol is wrong about both. The server renamed `session` → `project`; the
web invented a `plan` field and dropped `sandbox`.

Nothing catches it because:

- `RpcRouter.register<P, R>` (`ws/rpc.ts:8`) never constrains `R` to a protocol
  result type — handlers can return anything.
- The web declares its own `RpcMethodMap` (`lib/rpc.ts:8-35`) instead of deriving
  it from the protocol, so the two type-check independently against different
  truths.
- Params drift is papered over by `getProjectId(params)`
  (`ws/handlers/projects-handler.ts:6-9`), which casts to `unknown` and accepts
  `p.projectId ?? p.sessionId`. The handler is *declared* as taking
  `SessionAttachParams` (which has `sessionId`) while reading `projectId`.

**Fix:** put the method map in the protocol —
`RpcMethods = { 'projects.create': { params: …; result: … }, … }` — and type both
`register` and `call` from it.

Also outside the protocol entirely: `project.browse`, `projects.setModel`, and
all 14 `video.*` methods are registered on the server and called by the web with
locally-declared types.

### §9. `projects.sandboxStatus` is emitted and never consumed

The server emits it, the protocol defines `SandboxStatusPayload`
(`messages.ts:187`), and `SessionAttachResult.sandbox` carries it. The web has
**zero** occurrences of the string `sandbox` in `src/**`.

The UI never tells the user whether the session is actually confined. Related:
`SessionCreateParams.allowUnenforced` is commented *"Must originate from an
explicit user confirmation in the UI"* (`messages.ts:122`) — the web passes the
field through its RPC type (`lib/rpc.ts:14`) but no component ever sets it, so
the documented confirmation step does not exist.

### §10. `search_files` dispatches to a native function that doesn't exist

`packages/protocol/src/tools.ts:69` declares `nativeFn: 'searchSummary'`.
`sandboxed-worker.mjs:38` calls `native.searchSummary(args.query)`.

**`searchSummary` is not exported by vajra-core** — it appears nowhere in
`index.d.ts` or `index.js`'s export list. Any worker calling `search_files` gets
`TypeError: native.searchSummary is not a function`.

The CLI has the mirror-image bug: `roleTools.worker` includes `search_files`
(`tools.ts:306`) and `getWorkerToolSpecs()` sends it to the model, but
`dummyHandle`'s switch (`run.ts:307-366`) has no case for it, so it falls through
to `return \`Unknown tool: ${tool}\`` (`run.ts:365`) — returned as a *successful*
tool result. The worker burns turns against its 100-call budget on a tool that
can never work.

The `nativeFn` field is decorative throughout — no dispatcher reads it. Either
make it the single dispatch table or delete it.

Same class of gap: plans can declare `deleteFile` and `createDir`
(`tools.ts:156-162`) and `computeTaskPermissions` grants `delete`
(`run.ts:101-103`), but there is no `delete_file` or `create_dir` tool in the
worker's toolset at all. A `type: 'delete'` task cannot be executed.

### §11. `propose_plan`'s schema rejects ordinary plans **[verified]**

```
$ node -e "…propose_plan.schema.safeParse({tasks:[{title,description,instructions,
            readFile,writeFile,dependsOn,type}],summary})"
ok? false
tasks.0.deleteFile: Required
tasks.0.createDir: Required
tasks.0.validation: Required
```

`deleteFile`, `createDir` and `validation` are required arrays
(`tools.ts:195-200`) and are also in the JSON schema's `required` (`:274`).
Models routinely omit empty arrays, and any dispatcher using `def.schema.parse`
rejects the whole plan:

- `sandboxed-worker.mjs:103` — `def.schema.parse(args)` throws.
- `packages/cli/src/agent/tools.ts:260` — `safeParse` fails → `"Invalid arguments
  for 'propose_plan'"`.

The CLI escapes this only by special-casing `propose_plan` *before* it reaches
`parseToolCall` (`developer.ts:412`) and using its own lenient
`parseProposePlanArgs`, which defaults every missing array. Two parsers, two
definitions of a valid plan.

`packages/protocol`'s own conformance test is red because of this — see §42.

### §12. `run_command` has two incompatible implementations

| | CLI (`run.ts:319-362`) | sandboxed worker (`sandboxed-worker.mjs:41-55`) | native (unused) |
| --- | --- | --- | --- |
| execution | `spawn`, `shell: false` | **`execSync` — full shell** | `runCommand(cmd, args, cwd)`, no shell |
| parsing | `command.split(/\s+/)` | shell parses it | caller supplies argv |
| `&&`, pipes, quotes | broken | work | n/a |
| exit code on signal | reported as `0` | `e.status` | **`-1`** (`index.d.ts:107-110`) |
| blocking | async | **synchronous — blocks the IPC loop** | sync + async variants |

`packages/protocol/src/tools.ts:2-3` states: *"run_shell is deliberately not
offered — run_command (argv-based, no shell) covers file-editing tasks without
the shell-injection surface."* The sandboxed worker — the security boundary —
uses a shell anyway.

`native.runCommand` already provides argv execution with a correct `code: -1` on
signal, and `runCommandAsync` provides it off the event loop. Neither consumer
uses it, and both hand-rolled versions are buggy in ways the native one isn't.
The worker's `execSync` also makes its own `maxCpuTimeMs` watchdog
(`sandboxed-worker.mjs:163`) unable to fire — the timer can't run during a
synchronous call.

See §18 and §19 for the CLI-side consequences.

### §13. `list_files`'s second argument means two different things

Native: `listFiles(path, recursive?)` (`index.d.ts:55`).
Protocol schema: `{ path, recursive? }` (`tools.ts:52`) — consistent.
CLI wrapper: `listFiles(path, includeHidden?)` (`packages/cli/src/native.ts:27`)
— passed straight through to the native `recursive` parameter.

Nothing passes `true` today, so it's latent, but the name says the opposite of
what it does. Separately, the CLI's `list_files` tool drops the model's
`recursive` argument (`run.ts:318` calls `listFiles(a.path)`), so a request for a
recursive listing silently returns a shallow one.

### §14. Two role→tool tables that disagree

| role | `protocol/tools.ts:305` | `sandbox/tool-rules.ts:179` |
| --- | --- | --- |
| developer | read, list, **search**, **propose_plan** | read, list |
| master | read, list, search, run_command | read, list, run_command |
| worker | read, list, **search**, write, edit, run_command | read, list, write, edit, run_command |

If the sandbox layer ever enforced its table against the CLI's tool specs, the
developer's `propose_plan` call would be denied at dispatch and **no session
could ever produce a plan**. Latent only because Path A doesn't call
`resolveAllowedTools`. One of these tables has to go.

### §15. `retries` is written under one name and read under another

```
planner → t.retries
  → developer.ts:232   writes   maxRetries: t.retries      (phantom field)
  → taskqueue.ts:74    reads    task.retries ?? 2          (always undefined)
```

`PlannedTask` (`messages.ts:57`) has `retries`, not `maxRetries`. TypeScript
misses it because the object literal passes through `.map()`, which strips
excess-property checking. A planner that says `retries: 0` ("don't retry this
destructive task") gets the default of 2.

Same file, same class of drift: `validationStrategy` is
`'hierarchical' | 'incremental' | 'contextAware'` in the protocol
(`messages.ts:65`), but the CLI validates against
`['hierarchical','targeted','full','skip']` and casts with
`as PlannedTask['validationStrategy']` (`developer.ts:227`), producing values the
type says are impossible.

---

## Part IV — CLI commands that don't do what they say

### §16. `vajra config -s KEY VALUE` writes garbage **[verified]**

`index.ts:68` declares `.option('-s, --set <key> <value>', ...)`. Commander
supports exactly one argument per option — `<value>` is ignored. `options.set` is
the **string** `"OPENROUTER_API_KEY"`, and `index.ts:87` destructures a string
into characters:

```
options.set = "OPENROUTER_API_KEY"
key = "O" value = "P E N R O U T E R _ A P I _ K E Y"
```

So `vajra config -s OPENROUTER_API_KEY sk-...` appends
`O=P E N R O U T E R _ A P I _ K E Y` to `.env` and discards the key.
`writeEnvKey`'s validation doesn't catch it because spaces are legal in a value.
The help text at `index.ts:137` documents the broken form.

**Fix:** `.option('-s, --set <key=value>')`, or positional
`.argument('[key]').argument('[value]')`.

### §17. `-t, --timeout` is parsed and then thrown away

`index.ts:40` collects it, `run.ts:60` parses it, `run.ts:303` prints it. It is
never applied: `executeTask` uses `task.timeout`, which comes from the plan or
`taskqueue.ts:75`'s default of 120. `vajra run -t 600` changes nothing but the
banner.

### §18. Task timeout is seconds, but it's used as milliseconds

- `packages/protocol/src/tools.ts:96` — `run_command`'s `timeout` is documented
  as **milliseconds** (default 30000).
- `packages/protocol/src/tools.ts:~258` — a task's `timeout` is documented as
  **seconds** (default 120), and `taskqueue.ts:75` stores it that way.
- `run.ts:239` passes `timeout: task.timeout` straight into `run_command`, and
  `run.ts:339` uses it as `timeoutMs`.

A default task therefore kills every validation command after **120 ms**. Any
real `tsc --noEmit` or `npm run lint` is killed before it starts.

### §19. A killed or timed-out validation command counts as success

`run.ts:351`: `const exitCode = code ?? 0`. When `spawn`'s `timeout` fires, or the
process dies from a signal, `code` is `null` and `signal` is set — this maps it to
`0`, so `resolve(stdout || '(no output)')` returns the success shape and
`run.ts:242-248` parses no `exitCode`, defaulting to 0. Validation passes for a
command that was force-killed. Combined with §18, essentially **every** task
validates green.

**Fix:** `if (code !== 0 || signal) { …failure… }`, and surface the signal.
Better: use `native.runCommand`, which already reports `-1` on signal (§12).

### §20. `run_command` splits on whitespace with `shell: false`

`run.ts:321`: `command.split(/\s+/)`, and nothing else parses the string:

- `npm test -- --grep "login flow"` → argv `['test','--','--grep','"login','flow"']`
- `npm run build && npm test` → `&&` and the rest become literal arguments to `npm`
- `tsc --noEmit > out.txt`, pipes, globs — all silently wrong

The planner is prompted to emit shell-looking validation commands
(`developer.ts:157`, protocol examples `["cargo test", "cargo clippy -- -D warnings"]`),
so this bites constantly. Failures look like "validation failed" with no hint why.

### §21. `run_command` ignores the project directory

`run.ts:342`: `cwd: a.cwd as string | undefined` — when the model omits `cwd` (it
usually does; the schema says it "defaults to project root"), the child inherits
the CLI's `process.cwd()`. With `-d /elsewhere`, every build/test/git command runs
in the wrong repo.

**Fix:** `cwd: resolve(projectDir, (a.cwd as string) ?? '.')` plus a containment
check.

---

## Part V — Planning and agent-loop correctness

### §22. `dependsOn` can never match a task id

`propose_plan`'s schema has **no `id` field** per task (`tools.ts:180-200`) but
asks the model for `dependsOn: "Task IDs this depends on"`. The CLI invents ids
afterwards — `id: \`task-${i + 1}\`` (`developer.ts:215`) — then drops anything
that doesn't match:

```ts
task.dependsOn = task.dependsOn.filter(dep => taskIds.has(dep))   // developer.ts:239
```

Unless the model guesses the literal string `task-2`, **every declared dependency
is silently deleted**. Ordering then rests entirely on the file-overlap heuristic
in `addFileLevelDependencies` (`developer.ts:319`), which only sees files both
tasks list. Tasks that must be ordered for semantic reasons (migrate then seed;
add dep then import it) run in the wrong order.

**Fix:** add `id` to the task schema and use the model's ids (validating
uniqueness), or have the planner reference tasks by 1-based index and translate.

### §23. `search_files` never counts against the tool budget → unbounded loop

`developer.ts:8`: `FREE_TOOLS = new Set(['search_files'])`, and
`developer.ts:446-449` only increments `toolCallCount` for non-free tools. The
loop condition is `while (toolCallCount < MAX_TOOL_CALLS)` (`developer.ts:389`). A
model that keeps calling `search_files` — likely, since `searchSummary` returns
"No matching files found." for most queries (§29) — loops **forever**, issuing a
paid streaming request every iteration, with no exit and no user feedback.

### §24. Context compression can produce a request the provider rejects

`compressMessages` (`developer.ts:52`) keeps the system message plus the last 6
messages, skipping any that doesn't fit the token budget (`developer.ts:79`). It
prunes *orphaned tool results* (`:96`) but does nothing about the reverse case: an
assistant message with `tool_calls` whose tool results were skipped or fell
outside the window. OpenAI-compatible APIs reject that with a 400. The comment at
`developer.ts:69` says pairs are kept together; the implementation doesn't.

In `run.ts` the throw is caught at `run.ts:422` and printed as "API error … Check
your API key and network connection" — misleading for a session that was working
a moment ago.

**Fix:** walk backwards in complete units (assistant + all its tool results) and
admit or drop a unit atomically.

### §25. Unknown `skipIf` conditions cause the task to be skipped

`evaluateSkipIf` (`run.ts:27`) handles only `file exists:` and `file missing:`.
Any other string falls through and the function returns `true` at `run.ts:56` —
i.e. **skip**. The protocol's own example advertises `"command passes: npm test"`
(`tools.ts:~272`), which is not implemented. A plausible plan silently skips its
own tasks and reports success.

**Fix:** default to *not* skipping on an unrecognised condition, and warn.

### §26. A lock conflict permanently skips the task

`run.ts:490`: if `tryAcquire` fails, the task is `skipTask`'d and never retried,
even though the lock is released a few lines later (`run.ts:563`) when the current
task finishes. `FileLockManager` already provides `acquireOrWait`
(`file-locks.ts:117`) for exactly this.

### §27. Tasks with unresolvable dependencies vanish from the report

`getReadyTasks` (`taskqueue.ts:95`) requires every dependency to be `done` or
`skipped`. If a dependency id doesn't resolve (§22 — or a cycle that
`detectAndRemoveCircularDeps` mangles), those tasks stay `pending` forever;
`run.ts:474` breaks the loop, and the final report (`run.ts:568-573`) prints only
done/failed/skipped. The user is told "✅ Done!" while tasks were never attempted.

### §28. No request timeout, and retries duplicate streamed output

In `openrouter.ts`:

- No `AbortSignal` or client timeout anywhere (`:69`, `:200`, `:231`). A stalled
  stream hangs the CLI indefinitely, with no way out (§37).
- `retryAfterMs` (`:111`) reads `err.headers?.['retry-after']`, but the OpenAI SDK
  exposes a `Headers` object, not a plain record — so it always falls through to
  the constant `INITIAL_RETRY_DELAY_MS`. No exponential backoff at all: 5 retries,
  1 second apart.
- The stream retry at `:290` restarts the whole request, but text already emitted
  through `onTextDelta` stays on the terminal — a mid-stream 429 prints the answer
  twice.
- `isRateLimitError` (`:81`) doesn't cover transient network errors
  (`ECONNRESET`, `ETIMEDOUT`), the common failure for long streams.

### §29. Dead filters in the summary indexer

`summary.ts:5` defines `SKIP_DIRS` (`dist`, `build`, `.next`, `target`, …) and
never uses it — `shouldSkipFile` (`:59`) filters only `node_modules/` and `.git/`.
Build output is read from disk and ranked into the context budget. **This bug is
already fixed in two of its three copies** — see §30.

Likewise the `.min.js` / `.min.css` entries in `SKIP_EXTENSIONS` can never match,
because the extension is the last dot-segment (`:61`), i.e. `.js`.

Related: `searchSummary` (`:186`) requires **every** query term to appear in
`path + symbols` and doesn't search the preview — so multi-word queries almost
always return "No matching files found.", which feeds §23.

---

## Part VI — Duplication and drift

### §30. The same code exists three times, and the copies have diverged

`agent/summary.ts`, `agent/tree.ts`, `agent/tools.ts` exist in **three** places:
`packages/cli/src/agent/`, `experimental-packages/server/src/agent/`, and
`experimental-packages/agent-core/src/`.

`experimental-packages/agent-core` — a package whose entire purpose is to hold
this shared logic — has **no dependents**. Nothing imports it.

Measured drift:

| module | cli ↔ server | cli ↔ agent-core |
| --- | --- | --- |
| `tree.ts` | identical (0 diff lines) | different signature: `buildNestedTree(files: string[])` vs `(entries: ProjectFileEntry[])` |
| `summary.ts` | 155 diff lines | 289 diff lines |
| `tools.ts` | 68 diff lines | 85 diff lines |

The drift is not cosmetic. The server's copy contains a comment documenting the
fix for §29 that the CLI never received:

```ts
// experimental-packages/server/src/agent/summary.ts:79
// SKIP_DIRS was declared and never consulted, so build output — dist,
return path.split('/').some((segment) => SKIP_DIRS.has(segment))
```

`agent-core` has the same fix (`summary.ts:69`). A known, twice-fixed bug is live
in the shipping package. None of the three copies filters `isMasked` (§1).

**Fix:** make `agent-core` real — move `summary`, `tree`, `tools`, `plan` there,
have the CLI and server depend on it, delete the copies. It is already wired up as
a workspace package with a build script.

Two more orphans in the same vein:

- `packages/sandbox/src/daemon.ts` (288 lines) and `client.ts` (135 lines) are not
  exported from `index.ts` and have no importers. `SandboxClient` also keeps a
  single `pendingResolve` slot with no request-id correlation, so concurrent
  requests would mismatch responses.
- `worktree.ts` — added by commit e8355b9 "worktree isolation for task execution
  (7.1)" — is used only by `experimental-packages/server/src/agent/master.ts`. The
  CLI executes tasks directly in the project dir with no isolation. Likewise the
  CLI creates a `'master'` agent in its registry (`run.ts:299`) but has no
  `master.ts` at all; the branch is named `feat/master-agent` and the master agent
  exists only on Path B.

---

## Part VII — Packaging, tests, UX

### §31. `vajra secure` is dead on arrival **[verified]**

```
packages/sandbox/src/cli.ts:22
const native = require('vajra-core')
```

The package is `@codekalakaars/vajra-core`. This is a top-level require, so
*every* subcommand fails, including `vajra status` — the "is my sandbox working?"
diagnostic:

```
Error: Cannot find module 'vajra-core'
Require stack:
- /mnt/drive/Repo/vajra/packages/sandbox/dist/cli.js
```

11 of the sandbox package's 69 tests are red because of this one line.

### §32. Two packages claim the same `bin` name **[verified]**

`packages/cli/package.json` → `"bin": { "vajra": "dist/index.js" }`
`packages/sandbox/package.json` → `"bin": { "vajra": "dist/cli.js" }`

Installing both globally means one silently shadows the other. Already true
locally — inside `packages/cli`, the `vajra` binary resolves to the *sandbox*:

```
$ readlink packages/cli/node_modules/.bin/vajra → vajra-sandbox/dist/cli.js
```

The sandbox CLI's own docs call itself `vajra-sandbox` (`index.ts:9-11`); the
`bin` key doesn't match.

### §33. A publishable package depends on a private one

| package | `private` | publishable? |
| --- | --- | --- |
| `@codekalakaars/vajra-core` (root) | false | yes |
| `@codekalakaars/vajra-cli` | false | yes |
| `@codekalakaars/vajra-sandbox` | false | yes |
| **`@codekalakaars/vajra-protocol`** | **true** | **no** |

Both publishable packages have a hard runtime dependency on
`@codekalakaars/vajra-protocol`. `npm i -g @codekalakaars/vajra-cli` cannot
resolve it. Either un-private the protocol or bundle it.

### §34. `packages/cli` has no `files` field

A publish ships `src/`, `dist/`, `tsconfig.json` and any stray artifacts —
including the stale `dist/agent/manager.js`, which has no corresponding source
file. `tsc` doesn't prune `outDir`; add a clean step to the build script.

### §35. A fresh clone can't run the CLI without a Rust toolchain

`*.node` is gitignored (`.gitignore:24`) while the generated `index.js` and
`index.d.ts` *are* committed. After `git clone && pnpm install` the loader exists
but the binary doesn't, and `@codekalakaars/vajra-core` throws on import.
`pnpm build` (napi + cargo) must run first — worth stating in the README's Build
section, which currently reads as optional setup.

### §36. The documented dev workflow starts the demoted stack

Root `package.json:38`:
`"dev": "turbo run dev --filter=@codekalakaars/vajra-server --filter=@codekalakaars/vajra-web"`

Both are now in `experimental-packages/`. `pnpm dev` starts the experimental
server and web app; there is no script that builds and runs the CLI.

### §37. Ctrl-C doesn't quit

`run.ts:286-290` registers a SIGINT listener that only sets a flag. Because a
listener exists, Node's default "exit on SIGINT" is suppressed. During a
`readline.question` prompt or a long streaming request, Ctrl-C prints
"Interrupted. Cleaning up…" and then nothing happens — the only escape is Ctrl-\
or killing the terminal. The `interrupted` flag is checked only at loop boundaries
(`run.ts:406`, `:468`).

**Fix:** second SIGINT → `process.exit(130)`; pass an `AbortSignal` into the
stream so the first one actually interrupts (§28).

### §38. The first task prompt ignores "exit"

`run.ts:374-382` asks for a task; the `exit`/`quit` check lives only in the
*retry* loop at `run.ts:392`, entered only when the answer was empty. Typing
`exit` at the first prompt starts a session with the task "exit".

### §39. Plan confirmation defaults to yes, on a title-only summary

`run.ts:444` treats anything other than `n`/`no` — including a bare Enter, a typo,
or `yes please` — as approval, and `planSummary` (`streaming.ts:67`) prints only
the task titles. The user approves file-modifying work without seeing which files
will be written or what the instructions are.

**Fix:** prompt `[y/N]`, require an affirmative, and print `writeFile` targets and
validation commands per task.

### §40. `ink@7.1.1` requires Node ≥ 22; the package declares ≥ 18

`packages/cli/package.json:41` says `"node": ">=18.0.0"`;
`node_modules/ink/package.json` says `"engines": { "node": ">=22" }`. The TUI is
the *default* entry point (`index.ts:146`), so a Node 18/20 user hits it
immediately.

### §41. `config` writes to a `.env` derived from the install location

`getRootDir` (`env.ts:25`) resolves three levels up from the entry script —
correct for `packages/cli/dist/index.js` in a checkout, wrong for a global
install (`.../node_modules/@codekalakaars/vajra-cli/dist/index.js` →
`.../node_modules/`, wiped on reinstall). Meanwhile `findEnvPath` (`env.ts:38`)
implements a sensible cwd-walk **and is never called by `index.ts`**, which uses
`resolve(rootDir, '.env')` at `:19` and `:71`.

Also `index.ts:19` loads the repo `.env` before `index.ts:22` loads the cwd one,
and dotenv doesn't override by default — so a project-local `.env` can never win.

### §42. The test suites are red

| suite | result |
| --- | --- |
| root `test/*.test.mjs` (native core) | **31 pass**, 1 skipped, 0 fail |
| `packages/protocol` | **1 of 4 failing** |
| `packages/sandbox` | **11 of 69 failing** |
| `packages/cli` | **no tests, no `test` script** |
| `experimental-packages/server` | not run (has tests) |

- Protocol: `every tool schema validates its own well-formed example` fails. The
  in-test example still uses a `files: [...]` field and `validation: 'cargo test'`
  (a string) — shapes the schema hasn't had for a while. The contract package's
  only conformance test was never updated when the contract changed, and is now
  red for two independent reasons (stale example + §11's over-strict required
  fields).
- Sandbox: all 11 failures are §31.

The CLI — the package with the most logic and the one users run — has no test
directory at all. Turbo's `test` task exists but nothing in `packages/cli`
implements it.

### §43. `DEFAULT_MODEL` / `VAJRA_MODEL` are advertised but never read

`index.ts:109-115` lists them as known config keys, so
`vajra config -s DEFAULT_MODEL …` looks meaningful. Nothing reads them:
`index.ts:36` defaults to the hardcoded `DEFAULT_MODEL` constant, and `startTUI`
(`tui/index.tsx:270`) does the same.

### §44. `vajra video list` crashes on a non-200 response, and video breaks on Windows

`video.ts:16-20` never checks `response.ok` and immediately reads `data.items` —
a 404/5xx from raw.githubusercontent gives
`TypeError: Cannot read properties of undefined (reading 'filter')` instead of the
`handleError` message.

`execFileSync('npx', …)` (`video.ts:71`, `:92`, `:192`, `:210`) with no `shell`
option can't find `npx.cmd` on Windows and fails `ENOENT` — which `handleError`
reports as "npx not found. Install Node.js first." README claims Windows support.

### §45. Misleading end-of-conversation message

`run.ts:598` prints "Reached the 20-turn conversation limit. Starting execution
with current progress." — nothing is executed; the function returns immediately
after.

---

## Part VIII — Root cause and suggested sequence

Nearly every finding is a variant of one problem: **the packages share types but
not implementations, and nothing verifies the seams.**

- `protocol` defines shapes that no runtime code validates against (§8, §9, §15),
  and validators that no dispatcher uses (§10, §11).
- `sandbox` implements the enforcement engine, and the shipping consumer
  reimplements a weaker version inline instead (§2, §6, §12).
- `agent-core` was created to deduplicate the agent runtime and was never
  adopted, so the runtime exists in triplicate with real drift (§30).
- The one place types *would* have caught the drift — the RPC router and the web
  client — both opt out via `unknown` casts and locally-declared maps (§8).

**Suggested order:**

1. **Decide what the product is.** If it's the CLI, §1 and §2 are the whole value
   proposition and need wiring before anything else. If the server is coming
   back, say so in the README — the status table describes Path B while users run
   Path A.
2. **Stop the bleeding on data loss** — §4 and §5 are self-contained and can ship
   independently.
3. **Fix validation** — §18 + §19 + §20 together. Until they're fixed, task
   validation is meaningless, which makes every other execution bug invisible.
4. **Make the protocol enforceable.** Move the RPC method map into
   `packages/protocol` and type both `register` and the web's `call` from it; §8,
   §9 and §15 stop being possible.
5. **One implementation per tool.** Route both dispatchers through
   `native.runCommand`, make `nativeFn` the actual dispatch key, and resolve
   `searchSummary` (implement it or drop the tool from `roleTools`). §10, §12,
   §13.
6. **Fix the planner contract** — §22, then §11 and §14.
7. **Adopt `agent-core`** (§30). The CLI inherits the §29 fix for free.
8. **Two one-line packaging breaks** — `require('vajra-core')` (§31) and the
   duplicate `bin` name (§32) — then get the protocol and sandbox suites green
   (§42).
9. **Add a CLI test suite.** `evaluateSkipIf`, `computeTaskPermissions`,
   `compressMessages`, `parseProposePlanArgs`, `writeEnvKey` and `searchSummary`
   are all pure functions with no I/O to mock. One end-to-end test running
   `vajra run` against a fixture project with a stubbed provider would have caught
   most of this document.
