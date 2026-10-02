# ADR-0017: The Manager Compiles a Context Pack Per Task

## Status

Accepted.

## Date

2026-10-02

## Context

A Worker's opening prompt is a title, a why, the instructions as sentences, and four lists of paths. Everything else it needs, it spends rounds finding: a round to read the file it was told about, a round to work out where in it the change goes, a round to discover that the project's tests are run some way the plan never said.

The plan already knows more than the prompt shows. A `context` entry carries a path *and the reason it matters*; an `edit` carries an anchor — exact, unique text — and the file it belongs to; a `verify` carries the command and the exit code it must reach; a contract carries a decision two tasks must agree on. All of it is thrown away when the task is lowered into `readFile`, `writeFile` and `instructions`, and the Worker is left with paths it must read and prose it must interpret.

Two things made building this from a model call obviously wrong. A Worker that has to be *told* its own brief is a Worker that can be told the wrong brief, and a run whose briefs differ each time cannot be tuned, because two runs of the same suite are not comparable. And the prompt is the most expensive part of every round: whatever it carries is paid for on every round of the task.

## Decision

**The Manager compiles a context pack for each task, at dispatch, with no model call in the build.** The pack is a deterministic function of the plan, the files as they are on disk at that moment, and the handoffs of the tasks already finished. Same inputs, same text, same sha256.

**The pack goes in the system message, after the role rules.** The first user message says only that the task is to be executed now. A stable prefix is also what keeps the provider's prompt cache warm across a task's rounds and across its compactions.

**Files are read through the task's own handle.** `read_file` is the same call the Worker's own reads go through, so the permission gate and the masked-file stub apply to the pack too. A pack can never show a Worker more than that Worker was allowed to read.

**The pack has ten sections, in this order and this priority:**

| # | Section | Cuttable |
|---|---------|----------|
| 1 | Task: title, why, type, instructions, notes | no |
| 2 | Done means: success criteria, then each verify command with the exit it must reach | no |
| 3 | Previous attempt, on a retry ([ADR-0019](0019-a-retry-is-told-what-failed-and-a-finished-task-hands-off.md)) | no |
| 4 | Edits: each anchor with `anchorContextLines` around it, in the current file | no |
| 5 | Contracts this task produces or consumes | no |
| 6 | Scope: what it may write, delete and create | no |
| 7 | Upstream results: direct dependencies in full, transitive ones as interfaces | no |
| 8 | Context excerpts: each `context` ref with its reason, sliced to its symbols | **yes** |
| 9 | Project card: language, package manager, test, build and lint commands | no |
| 10 | Retrieval hints: what was cut, and the exact call that fetches it back | when anything was cut |

**Only the excerpts degrade.** They are the one section a Worker can do without — every path is on disk and re-readable — and the first thing a Worker does with a file it was handed is read further into it. The budget is `packWindowShare` of the model's window, and over it the excerpts are cut last-declared first, each one down through body → declarations → path only. Every cut is named in section 10 with the call that gets it back, the way `output-cap.ts` names what it cut. Nothing disappears silently.

**An anchor that has moved is reported, not guessed.** If the planned anchor is not in the file, it is looked for again by its longest line that appears exactly once; if that line is gone or no longer unique, the anchor is marked `stale`. Three answers, because "it moved" and "it is gone" ask different things of a Worker, and an anchor copied from a stale pack edits the wrong place.

**A pack whose fixed sections alone exceed the budget is a setup error.** There is nothing the runtime may cut that would make them fit, so `vajra bench` refuses the suite with exit 2 and says "split this task or narrow its context" before the sandbox pool is forked. It is a property of the suite, not of the arrangement, and a Worker handed a truncated brief is a measurement of nothing.

**A pack that cannot be built is a warning, not a failure.** One unreadable file is named in the pack, and the rest of it is used.

## Consequences

**Positive**

- **A Worker starts on the file it was told about.** With the anchor and its window already in the prompt, the first round is a decision about the change rather than a hunt for the change.
- **A run is reproducible.** The pack's hash is in the result, so two runs can be compared on the same brief, and a Worker that fails on one is a Worker that fails on the other.
- **The plan's structured fields finally reach a Worker.** Reasons, anchors, verify commands, contracts and notes were already validated; they are now shown.
- **The project's own commands are stated once per run**, in a card built mechanically from its manifests, instead of being discovered per task.
- **What was cut is visible**, and re-readable by one named call.

**Negative**

- **The prompt is larger, and it is paid for on every round.** A pack that shows what the Worker does not need is a smaller `roundsToFirstEdit` problem bought with a bigger denominator. `packWindowShare` and the anchor window are the two numbers to tune.
- **Excerpts go stale between dispatch and use.** They are read once, at dispatch; a task that reads a file the pack showed later gets whatever the file says then.
- **The relocation heuristic is crude.** It finds a site by a unique line or gives up; it never guesses. A Worker whose anchor was genuinely rewritten has to find it, and the metrics say how often that happens.
- **Compiling a pack costs reads at dispatch.** Every task reads the files it declares. That is bounded by the plan and is paid once per attempt, not once per round.

**Neutral**

- With `contextPack` off, the Worker gets exactly the prompt it has always got, and no pack is built at all — the switches default to off so the first tuned numbers are the ones the replay fixtures pin.
- The pack is held in memory for the run and written into `result.json`. It is not persisted per task; a handoff and a pack are only meaningful for the tree they were compiled against.

## Open Questions

- Should a pack carry a symbol index, so an excerpt is a set of declarations rather than a line window?
- When a suite's fixed sections do not fit, should the Manager be allowed to propose the split rather than refusing the suite?
- Should the anchor window show more of the file for an edit inside a large function than for one at the top level?

## See Also

- [ADR-0015 — Workers Compact Their Own Context](0015-workers-compact-their-own-context.md)
- [ADR-0018 — Compaction Is a Ladder](0018-compaction-is-a-ladder.md)
- [ADR-0019 — A Retry Is Told What Failed, and a Finished Task Hands Off](0019-a-retry-is-told-what-failed-and-a-finished-task-hands-off.md)
- [Sweeps](../../bench/sweeps/README.md)