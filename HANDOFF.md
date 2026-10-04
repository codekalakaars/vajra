# Handoff: making Vajra's Workers faster, safer and cheaper

Written 2026-10-02 at the end of a long working session, for the agent that picks this up. Everything you need from that session is here: what is built and committed (and which part is unproven), what the measurements say, what to do next and in what order, and the traps already stepped in.

---

## Prompt for the agent

Copy this as your task, or read it as your instructions:

> You are continuing work on Vajra, in `/mnt/drive/Repo/vajra` on branch `feat/cli-agent-v1-config`. Vajra runs a plan of tasks on parallel, sandboxed Workers under a Manager; a Developer creates the plan from a conversation (`vajra run`), or a predefined suite supplies it (`vajra bench`).
>
> 1. **Read first, in this order:** `AGENTS.md` (code map and rules), `docs/architecture.md` (how it fits together), then this file in full. `docs/bench-and-tuning.md` has every run parameter.
> 2. **Check the state before changing anything.** Run `git status` (the tree should be clean) and `git log --oneline -6` (section 1 lists what the latest commits are). Then run `pnpm build:all && pnpm test:all` and confirm it is green (section 1 gives the expected counts). One committed change, the batching prompt in `worker/prompt.ts`, has never been measured (task 0).
> 3. **Ask the user before running anything against a real model:** whether their approval of real-model runs from the last session carries over (section 2). Do not assume it.
> 4. **Then work through section 5 in order.** Each task says what is wrong, where (file and line), the fix, how to test it, and how to measure it. Do one task at a time: change, build, `pnpm test:all`, measure if the task says so, then report and ask before committing. Do not batch several tasks into one change.
> 5. **Measure before you claim.** Speed claims need at least 5 repetitions per suite on `zen/space-bunny-free`, compared by median against the baselines in section 4, with p90 reported too. The provider's latency varies 2 to 5 times between runs, so one run proves nothing.
> 6. **Report like this:** what you changed, the test counts, the measured effect against the baseline (or "not measured"), and anything you found that is not in this file. Keep that report short.
>
> Stop and ask when: a fix would change behaviour the user has not agreed to, a measurement contradicts this file, or a task turns out bigger than described here.

---

## 1. Where things stand

### Committed (latest first)

| Commit | What |
|---|---|
| `f0e1489` | The governor throttles only for CPU load this run causes (`cpuOwnMin`), and results record peak CPU and our share of it |
| `08cb2bb` | `vajra run` wires the Developer to the Manager (`developer/conversation.ts`, `cli/run.ts`) |
| `b06f6d5`, `e6f5dd1`, `f3d237e`, `95e0284` | Big files split (`executeTask`, `master.ts`, `bench/run.ts`, `developer.ts`, `execute-plan.ts`), behaviour tests for `executePlan` and the Developer budget |
| `afe8935` | Repository cleaned to Developer, Manager and Worker; restructured into four packages (`protocol`, `native`, `sandbox`, `vajra`) |
| `56a84c6`, `a48daca`, `6c1fcf2` | Malformed tool-call JSON gets a clear error; the context pack turned on in `bench/config.json`, with the sweep that justified it |
| `fa47d54` | A failed attempt is no longer marked a no-op, so `retries` actually retries |

### Committed at the end of the last session, on top of the table above

Three commits, in this order (look them up by subject with `git log`):

**1. "perf(model): re-send a request that goes quiet; count stalls; stop returning truncated answers"** (stall watchdog). Built, tested, and run in a 15-run sweep.
- `packages/vajra/src/model/chat.ts`
  - Each request attempt has an idle watchdog (`stallMs`), reset on every chunk. If the request goes quiet (no headers, or no chunk mid-stream), it is aborted and the round re-sent through the existing retry loop (up to `MAX_RETRIES` = 5, 1 s apart). Each stall emits an `llm-stall` event.
  - **Bug fixed:** the OpenAI SDK ends an aborted stream quietly, as if finished. Before, a caller's abort mid-stream returned a truncated answer as complete. It is now checked after the stream loop.
- `bench/config.json`, `packages/vajra/src/bench/params.ts`, `bench/config.ts`: new required key `modelStallSec` (45).
- `packages/vajra/src/worker/execute.ts`: passes `stallMs: params.modelStallSec * 1000` on both model calls.
- `packages/vajra/src/manager/ui.ts`: the `llm-stall` `AgentEvent`.
- `packages/vajra/src/bench/metrics.ts`, `result.ts`: `slowestRoundMs` and `stalledRequests` per task, `stalledRequests` per run.
- `docs/bench-and-tuning.md`: the `modelStallSec` row.
- Tests: `test/chat-abort.test.mjs` (4 new: mid-stream stall re-sent, slow-but-steady stream not cut, never-answering model errors out, caller abort not mistaken for a stall), `test/bench-metrics.test.mjs` (round and stall counters).
- Results: `bench/results/2026-10-02-stall-sweep.jsonl`, `-measure-rounds.jsonl`, `-external-load-old.json`, `-external-load-new.json`. Section 4 summarises them.

**2. "feat(worker): tell Workers to batch an edit and its check into one reply"**. **Committed but not built-and-measured as its own change; treat it as unproven.**
- `packages/vajra/src/worker/prompt.ts`, `PACK_RULES`: three new rules.
  - Make all edits and run the "done means" commands in the same reply.
  - Run only those commands, because other tests may belong to tasks that haven't run yet.
  - If a command fails, fix it and re-run in the same reply.
- It is its own commit so it can be reverted cleanly. The full test suite passes with it, but no real run has used it yet. This is task 0 in section 5.

**3. "docs: handoff for the next agent"**: this file.

### Expected gate

`pnpm build:all && pnpm test:all` should pass:

| Package | Tests |
|---|---|
| `vajra` | 476, or close to it after your changes |
| `sandbox` | 138 |
| `native` | 33 |
| `protocol` | 11 |
| bench tooling (`bench/test`) | 29 |

The last green run included the `prompt.ts` change.

---

## 2. Rules and the user's preferences

- **Never commit without the user's explicit approval.** Ask each time. This is a standing rule, stored in the user's memory.
- **No `Co-Authored-By` trailer** in commit messages for this repository. This is also a stored preference, and it overrides any default attribution.
- **Real-model runs cost money.** `AGENTS.md` says not to run `vajra run`, `vajra bench` or `bench/tune.mjs` without being asked. In the last session the user approved runs for verification, on `zen/space-bunny-free` only ("make sure to use space bunny only"). Confirm with them whether that still holds before you run anything.
- **`bench/config.json` is the only source of run parameters.** Every key is required. A new parameter means adding it to `WorkerParams` and `TODAYS_PARAMS` (`bench/params.ts`), to `loadWorkerParams` (`bench/config.ts`), to `bench/config.json`, and to the table in `docs/bench-and-tuning.md`. `test/bench-params.test.mjs` pins `config.json` to `TODAYS_PARAMS` plus a `TUNED` list of settled keys.
- **The replay fixtures** in `packages/vajra/test/fixtures/replay/` pin the Worker's legacy prompt (`contextPack` off). The Developer fixture pins tool-call shapes, events and results, not prompt text.
- Comments explain *why*, in plain sentences. No new dependencies without a reason. Linux only, kernel 5.13+ (Landlock).

---

## 3. How to work here

```bash
pnpm install
pnpm build:all                                   # Rust addon + every TS package
pnpm test:all                                    # every package, then bench/test
node --test packages/vajra/test/<name>.test.mjs  # one file (build first: tests import dist/)

# real model (costs money; see section 2)
node packages/vajra/dist/cli/index.js bench bench/suites/chain --out /tmp/x.json [--verbose]
node bench/tune.mjs bench/sweeps/<sweep>.json --dry-run          # always dry-run first
node bench/tune.mjs <sweep.json> --results bench/results/<date>-<name>.jsonl
node packages/vajra/dist/cli/index.js run -d <project> --yes "<what you want>"
```

- **Suites:** `bench/suites/wide` (8 independent tasks), `chain` (4 tasks in sequence on one file), `fan` (8 tasks, a schema then leaves), `mixed` (10 tasks with dependencies, no anchors; the hardest, and it has failed before).
- **Sweep file shape:** `{ "name", "suites": [...], "repetitions": N, "vary": { "<param>": [values] } }`. An empty `vary` runs the committed config.
- **Reading results:** every line of a `.jsonl` is `{suite, repetition, values, result}`. `result` is a `BenchResult` (`packages/vajra/src/bench/result.ts`) with per-task `modelRounds`, `toolCalls`, `slowestRoundMs`, `stalledRequests`, `seeks`, `seekRatio`, `redundantReads`, `roundsToFirstEdit`, `packTokens`, `attempts`, and per-run `wallMs`, `criticalPathMs`, `idleMs`, `pausedMs`, `peakCpu`, `peakOwnCpu`, `stalledRequests`, `mostMissedPaths`.
- **Seeing what a Worker does:** `vajra bench <suite> --verbose` prints every tool call as `task → tool summary` and `task ← tool result`. Note that the harness's own verification run also appears as a `run_command`.

---

## 4. What the measurements say (baselines to compare against)

All measurements on `zen/space-bunny-free`, an 8-core Linux machine, with the context pack on unless stated.

### The context pack
Committed in `bench/results/2026-10-02-context-pack.jsonl`; 5 reps each; all 30 runs succeeded.

| Suite | Pack off: median | Pack on: median | Rounds per task (off → on) |
|---|---|---|---|
| `wide` | 54.5 s | 28.4 s | 8.3 → 3.8 |
| `chain` | 161 s | 94.6 s | 7.8 → 4.2 |
| `fan` | 300 s | 172 s | 11.8 → 5.7 |

With the pack off, 4 tasks needed a retry, each after a stall that ran out the 300 s timeout. With it on, none did. Per-task duration with the pack on: p50 19 s, p90 55 s, p95 93 s, p99 239 s. Four tasks took over 120 s and still succeeded on their first attempt, so **do not shorten `taskTimeoutSec`**: it would kill healthy slow tasks.

### Before the governor fix
`bench/results/2026-10-02-measure-rounds.jsonl`: 10 runs, `wide` and `chain` ×5.
- `wide` took 59 to 262 s.
- Two runs lost 158 s and 237 s to idle time: tasks were ready but held back. The likely cause is other programs' CPU load, because the old governor read machine-wide CPU.
- One run lost 93 s to a single 123 s model request.

### The governor under external load
`bench/results/2026-10-02-external-load-*.json`. I ran `wide` with 8 busy-loop processes unrelated to Vajra running alongside it.
- With every busy CPU counted (`cpuOwnMin` 0.0001): 144 s, 515 s of Worker time paused, 129 throttle readings.
- With only our own load counted (`cpuOwnMin` 0.1): 25 s, 1 s paused.

### After both fixes (governor and stall watchdog): **the current baseline**
`bench/results/2026-10-02-stall-sweep.jsonl`: 15 runs, all succeeded. This ran on the built code without the Commit B prompt change, so it is the baseline for task 0.

| Suite | Median | p90 | Idle | Seek ratio |
|---|---|---|---|---|
| `wide` | 63.9 s | 313.9 s | 74 ms | 14% |
| `chain` | 98.0 s | 109.0 s | 2 ms | 5% |
| `fan` | 146.8 s | 234.9 s | 55 ms | 43% |

- The watchdog caught 6 stalls in 5 of the 15 runs.
- The slowest rounds were still 81 s and 90 s, which looks like repeated stalls on a slow gateway.
- No run had more than 5 s of idle time.
- `wide` was slower than in the context-pack sweep while `fan` was faster. That is provider variance, not a regression.

### What a Worker does, today
From a verbose `chain` run, the typical task is 3 rounds with one tool call per round:

```
round 1: edit_file            (sometimes read_file first: one more round)
round 2: run_command <its verify command>   → passes
round 3: "done" text          (then the harness runs the same verify command again)
```

- With the pack on, a task averages 4.4 rounds, and the most common count is exactly 3. Only about 1.1 model-issued tool calls are made per round, so Workers almost never batch.
- A round costs about 5 to 10 s, so rounds are where the time goes.
- One `chain` Worker ran the project's whole test suite (`node --test`), saw it fail (later tasks' tests aren't satisfied yet), and lost several rounds on that.

### `vajra run` against a real model
Once, on an empty project: "create `src/greet.js` exporting `greet(name)` and a test".
- The Developer produced a 3-task plan run in sequence (stub, test, implementation) because of Phase One (task 2). It took about 8 minutes, and the result was correct.
- A first attempt with `--yes` stopped with nothing run: the Developer replied with text and no plan, and the unattended person said "stop". `--yes` now nudges instead.

### `mixed`
One pack-off run failed: `mixed-parse-merge` failed all 3 attempts (98 rounds), so the 4 tasks behind it never ran. An earlier `mixed` run was killed after 41 minutes with a Worker flailing (scratch files, `chr(96)` workarounds for backticks). That flailing is consistent with the malformed-JSON error message fixed in `56a84c6`, but it was never proven to be the cause.

---

## 5. The work, in order

Each task lists: **problem**, **evidence**, **where**, **fix**, **test**, **measure**, **done when**.

### Task 0: measure the batching prompt (it is committed but unproven)
- **Problem it targets:** Workers make one tool call per round, so a task takes 3 rounds where 2 would do.
- **Fix:** already committed in `worker/prompt.ts` (`PACK_RULES`), as its own commit. Only the context-pack prompt changes; the legacy prompt and its replay fixture are untouched.
- **Measure:** run `chain` and `wide` ×5 on the committed build (do not rebuild mid-run). Compare rounds per task (baseline about 4.0 to 4.2) and median wall time against the current-baseline table in section 4.
- **Done when:** rounds per task drop clearly, for example below 3.5, and success stays 5 of 5. If not, revert that commit (`git revert <hash>`), tell the user, and note the result in section 4.

### Task 1: the validation server runs unsandboxed, with the API key (security, do this first among the fixes)
- **Problem:** when a task's validation needs a server, the harness starts the project's server outside the sandbox with the parent's full environment, which includes `OPENCODE_API_KEY`. That server is code a Worker just wrote.
- **Where:** `packages/vajra/src/worker/execute.ts:508`, `spawn('node', [serverEntry], …)`, and `:512`, `env: { ...process.env, PORT: … }`. Workers get an allow-listed environment instead: `WORKER_ENV_ALLOWLIST` in `packages/sandbox/src/process/spawn.ts:106` (`PATH`, `HOME`, `TMPDIR`, `NODE_ENV`).
- **Fix, step 1 (do now):** export the allow-list environment builder from `@codekalakaars/vajra-sandbox` and use it for the server, plus `PORT`.
- **Fix, step 2 (propose to the user):** run the server inside the sandbox. That needs a way to start a background process in the confined worker (`sandbox/src/process/worker.ts`); today `run_command` blocks until the command exits.
- **Test:** a fake server entry that writes its `process.env` to a file. Assert there is no `OPENCODE_API_KEY` and no other unlisted variable.
- **Done when:** the test passes, and the gate is green.

### Task 2: the Developer mandated "Phase One" (done in code, not yet measured)
- **What changed:** the prompt no longer asks for stub, test and implementation tasks. It asks for one task per unit of work with its test inside it. The `write_stub` and `delete_stub` tools are removed from the protocol, the sandbox and the Developer's evidence rules. `propose_plan` now measures any verify command the model did not run and sets each command's `kind` from its exit code (`developer/developer.ts`, `measureUnmeasured` and `settleKinds`).
- **Still to do:** measure it. Run `vajra bench-plan bench/developer/todo-basic` and `todo-scope-trap` a few times and compare with the earlier results: 10 tasks, 18.6 and 8.8 minutes, about 20 model rounds before the first proposal. Report task count, time, rounds before the first proposal, and rejections. If plans get worse (tasks that prove nothing), find out why before changing the prompt again.
- **Done when:** the plan for `todo-basic` is 4 to 8 tasks and the run takes much less than the earlier 18.6 minutes.

### Task 3: Workers can't read what their task depends on
- **Problem:** a task may read only the files it declares. A dependent task gets "Access denied" on the files its dependency just wrote, and on the project's manifests, and loses a round guessing.
- **Evidence:**
  - In `fan`, the leaf tasks (`fan-leaf-*`) declare only their own test file, so they cannot read `src/schema.js`, the file `fan-schema` writes.
  - `fan`'s seek ratio is 43%, with 2.6 seeks per task.
  - `package.json` appears in `mostMissedPaths` on `wide` and `fan`.
  - A Worker in the real `vajra run` reported "Access denied" on `package.json`.
- **Where:**
  - `packages/sandbox/src/process/task-permissions.ts:22` (`computeTaskPermissions`; reads are granted at line 45, from `task.readFile` only).
  - Called from `packages/vajra/src/manager/run-task.ts:89`.
  - What a dependency wrote is known from `manager/attempts.ts` (handoffs record `filesWritten`).
- **Fix:**
  - Grant **read-only permission without a lease** for the files that completed direct dependencies wrote, and for the manifests (`package.json`, `tsconfig.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`).
  - **Do not** add them to `task.readFile`. That would add read leases, and with `readLocks: "exclusive"` every leaf reading `schema.js` would then wait for the others.
  - Show those files in the pack's "Upstream results" section (`worker/pack.ts:200`, `renderHandoff`): their full content when small, otherwise their declarations. Respect the pack budget.
- **Test:** a permissions unit test (a dependent can read its upstream's output and cannot write it), and a pack test (the upstream content appears).
- **Measure:** `fan` ×5. Compare seeks per task (2.6), seek ratio (43%), rounds per task (5.7) and median (146.8 s).
- **Done when:** seeks and rounds drop, with 5 of 5 success.

### Task 4: the pack withholds the file it has already read
- **Problem:** for a modify edit, the pack reads the whole file but shows only ±`anchorContextLines` (12) lines around the anchor, and nothing at all when no anchor was planned. The Worker then spends a round reading the file.
- **Evidence:**
  - `redundantReads` is 0.25 to 0.36 per task (reads of files that were in the pack).
  - All 10 `mixed` tasks and 7 of 8 `fan` tasks have no anchors.
  - Two of four `chain` Workers read `src/steps.js` before editing.
- **Where:** `packages/vajra/src/worker/pack.ts:327` (the no-anchor message) and `:361` (`windowOf(lines, site.line, radius)`).
- **Fix:** when the file is small, show it whole: under a threshold such as 4,000 characters, or within the remaining pack budget. Keep the anchor block. This is a new parameter (for example `packWholeFileMaxChars`); add it the way section 2 describes.
- **Test:** pack tests for anchored, unanchored and over-threshold files.
- **Measure:** `chain` and `mixed` ×5. Compare `redundantReads`, `roundsToFirstEdit` and rounds per task.

### Task 5: command locks serialise test runs on real projects
- **Problem:** every `npm`, `npx`, `pnpm`, `yarn`, `git` or `cargo` command takes one exclusive, project-wide lock for as long as it runs, and a task is not admitted while another holds it. On a real project where every task verifies with `npm test`, all test runs happen one at a time. The suites use `node --test`, so the bench cannot show this.
- **Where:** `packages/vajra/src/manager/command-locks.ts:10-17` (`COMMAND_RESOURCE_PATHS`, `commandResourcePath`), and admission in `packages/vajra/src/manager/execute-plan.ts:275`.
- **Fix:** lock only commands that change shared state.
  - Package managers: `install`, `i`, `ci`, `add`, `remove`, `rm`, `uninstall`, `update`, `up`, `upgrade`, `link`.
  - `git`: `add`, `commit`, `checkout`, `switch`, `reset`, `merge`, `rebase`, `stash`, `pull`, `fetch`, `clean`, `rm`, `mv`, `restore`, `apply`, `cherry-pick`.
  - Read-only subcommands take no lock: `npm test`, `npm run …` and `npx …` in general, `git status`, `git diff`, `git log`, `git show`.
  - `cargo` locks its own target directory, so consider dropping it.
- **Test:** a unit table of commands to expected lock (or none), plus an `executePlan` test where two tasks run `npm test`-style commands at the same time.

### Task 6: settle `readLocks`
- **Problem:** `readLocks: "exclusive"` (in `bench/config.json`) makes tasks that only read the same file queue behind each other. In `mixed`, 4 tasks read `src/parse.js`. In `fan`, 2 read `src/schema.js`. In `chain`, all 4 touch `src/steps.js`.
- **Fix:** a measurement, not code. Run `node bench/tune.mjs bench/sweeps/read-locks.json --suites fan,mixed`. The full file is 40 runs, so cutting it to `fan` and `mixed` halves that.
- **Done when:** if `shared` wins with 5 of 5 success, it goes into `bench/config.json` and `TUNED` in `test/bench-params.test.mjs`, with the results committed.

### Task 7: the session header changes on every request; caching is invisible
- **Problem:** `createClient` creates a new random `x-opencode-session` for every request, so every round of a Worker looks like a new session to the gateway. The old provider doc says the header exists "so gateway-side logs can be correlated with a Vajra run", and a value that changes every round defeats that. If the gateway also uses it to route or cache prompts, every round is a cache miss. We cannot tell, because usage parsing ignores cached tokens.
- **Where:** `packages/vajra/src/model/chat.ts:114-125` (`createClient`; the header is at line 117) and `:309` (`toUsage`).
- **Fix:**
  - Pass one id per run, or per Worker attempt, through `ChatCompletionRequest` and use it for the header. `executePlan` already has a `sessionId`.
  - Read `usage.prompt_tokens_details.cached_tokens` in `toUsage`, add `cachedTokens` to `TokenUsage`, and record it in the metrics.
- **Measure:** `wide` ×5. Does `cachedTokens` appear at all, and does round time change?

### Task 8: verification runs twice
- **Problem:** after the Worker ends, the harness runs the task's verify commands, even when the Worker ran the identical command on an unchanged tree and it passed. That costs about 0.1 s on the suites, but doubles test time on a real project.
- **Where:** `packages/vajra/src/worker/execute.ts:534`. The `WorkLedger` (`worker/ledger.ts`) records every call with its command and result.
- **Fix:** skip a validation command when the ledger shows the identical command passed after the last mutating call. Be strict: the same command string, and no write after it.
- **Test:** one test where it is skipped (passed, no write after) and one where it runs (a write came after).

---

## 6. Smaller experiments and open questions

| Idea | Why | How to try |
|---|---|---|
| Stop when verified | After task 0, the last round is often just "done". Ending the attempt as soon as every verify command has passed would save that round. The cost is the model's closing summary, which handoffs use; their files and interfaces come from the harness | A config switch `stopWhenVerified`, then a sweep |
| `parallel_tool_calls: true` | It might make the model batch on its own | Add to the request in `chat.ts`. The gateway may reject unknown fields, so test with a single request first |
| `temperature` | Not set today. A lower value may mean fewer wandering rounds | A new parameter, swept on `chain` and `fan` |
| Time to first token per round | Shows whether a round's 5 to 10 s is waiting or generating, which decides whether shorter outputs help | Record the first chunk's time in `watchRound` (`chat.ts`) and add it to `llm-end` and the metrics |
| `modelStallSec` value | 45 s caught 6 stalls in 15 runs, but slow rounds of 81 to 90 s remained | A sweep over `[30, 45, 60]` |
| Repair within an attempt | A failed verify throws away the whole attempt (`execute.ts:583`). Giving the Worker the failure once more might be cheaper. ADR-0016 deliberately chose a fresh attempt instead | Test on `mixed` only, as a switch |
| Plan granularity | A `chain` of 4 same-file tasks pays for 4 packs and about 12 rounds | Developer guidance to merge adjacent same-file steps; measure with `vajra run` |
| Why `mixed` fails | `mixed-parse-merge` failed 3 attempts (98 rounds) | Run `mixed --verbose` once and read what the Worker does |

---

## 7. Traps already stepped in

- **`sed -i` fails on this disk** (an NTFS mount, "preserving permissions … Operation not permitted"). Edit with the Edit tool or a short Python script.
- **`pgrep -f <pattern>` inside `bash -c` matches its own command line** and reports "running" forever. Use `pgrep -f "[t]une.mjs"`, or check the results file.
- **`pkill -f` with a broad pattern killed the agent's own shell** (exit 144). Be specific, and use `pkill -f 'while\(true\)'` for the CPU-burner test.
- **Do not rebuild while a bench or sweep is running.** Runs execute `dist/`, so a rebuild mid-sweep mixes two versions into one measurement.
- **Tests import `dist/`.** Build before testing.
- **`cpuOwnMin: 0` is rejected** (fractions must be in (0, 1]). Use `0.0001` to emulate "every busy CPU counts".
- **OpenAI SDK:** `signal` and `timeout` are request options (the second argument), never body fields. A stream aborted mid-way ends quietly instead of throwing, which `chat.ts` now handles after the loop.
- **Regex-based import pruning removed a real interface property once.** Use `tsc --noEmit --noUnusedLocals` to find unused imports, and edit by hand.
- **The machine runs other heavy programs** (`opencode serve`, Chrome, other agent sessions). That is why the governor must not count their CPU, and why one run proves nothing.
- **Bench runs take 30 s to 5 minutes each, and a real `vajra run` took about 8 minutes.** Run sweeps in the background with `nohup … &` and log to a file.
