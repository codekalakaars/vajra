# ADR-0018: Compaction Is a Ladder

## Status

Accepted. Amends [ADR-0015](0015-workers-compact-their-own-context.md).

## Date

2026-10-02

## Context

[ADR-0015](0015-workers-compact-their-own-context.md) gives a Worker one answer to a full window: compact into a checkpoint, or report `stuck`. That is the right answer when the window is full of things the Worker cannot do without. It is a very expensive answer to give for a window that is mostly full of things it has already finished with.

In practice a Worker's conversation is mostly spent. A file it read and then edited is stale; a command it ran four times has one useful fact in its fourth output; a search it has already read will not be read again. None of that needs a model to summarise and none of it should cost a round to remove.

The shipped code has one more thing, which is the backstop and not a rung: the oldest exchanges are dropped at the window, with the system prompt and the task message pinned. That is correct and it is lossy in the worst way — it drops whatever happened to be oldest, which is usually not what stopped mattering.

## Decision

**Compaction is a ladder, and the runtime climbs it.** Each rung is cheaper than the one above it, and the runtime takes the lowest rung that answers the problem.

| Rung | Trigger | What happens | Model call |
|------|---------|--------------|------------|
| 0 Cap | every tool result | the most of one result the Worker keeps, naming what was cut and how to get it back | none |
| 1 Elide | `elision` on, measured share ≥ `elideAt` | stale tool results rewritten in place | none |
| 2 Checkpoint | `checkpoints` on, share ≥ `compactAt` | one forced `write_checkpoint` call, then the conversation becomes system + task + checkpoint | one |
| 3 Stuck | checkpoint over `stuckCheckpointShare` of the window, or `maxCompactionsWithoutProgress` compactions with no progress | the attempt ends `stuck` | — |
| Backstop | always | drop-oldest trim at the window, task pinned | none |

**Elision rewrites, it does not remove.** The conversation keeps its shape — same messages, same order, same tool_call_ids — and only stale results shrink: a read superseded by an edit or a re-read becomes a note that names the file and the call that fetches it again; an older run of the same command keeps its exit code and the last `elidedTailLines` lines; an edit result becomes `ok: edited <path>`; an older search result becomes the paths it matched. The last `keepRecentRounds` rounds are never touched, and a read nothing has superseded keeps its contents, because it is the only copy the Worker has.

**The runtime asks for the checkpoint and the model may not volunteer it.** The forced round offers exactly one tool, `write_checkpoint`, and requires a call to it. The Worker never sees that tool during ordinary work, because a Worker that may compact whenever it likes will compact instead of working.

**Two checkpoint fields are the runtime's.** `filesChanged` comes from the ledger of what the harness actually changed, and `lastVerification` from the command it recorded with its exit code. Everything else — decisions and reasons, done, remaining, notes — is exactly the part only the model knows, and it is the model's to fill.

**A compaction carries a diff.** The L1 block is the checkpoint, the ledger's commands and exit codes, and a common-prefix/suffix diff of the changed files within `checkpointDiffChars`. A Worker resuming after a compaction needs to see its own half-finished edit, and the diff is cheaper than re-reading the file.

**Progress is measurable, and not progressing is stuck.** A file written that had not been written before, or a check that now passes where it did not. `maxCompactionsWithoutProgress` compactions with neither ends the attempt, which separates a task that is too big from a Worker going in circles.

**Every attempt ends as one of seven things** — `done`, `failed_verification`, `stuck`, `error`, `timeout`, `budget` (its tool calls ran out), `interrupted` — reported with the failing command and its output, its last checkpoint, the files it wrote and its closing words. The record describes what the attempt *was*; whether it counts as success is a separate question, and the two are allowed to differ: an attempt that ran out of tool calls can still have left correct work behind.

## Consequences

**Positive**

- **The cheap answer is tried first.** A Worker whose window is full of stale reads now loses a model call and keeps working.
- **Nothing disappears silently.** Every rewrite says what it replaced and how to get it back, so a Worker can tell "I already saw this" from "this is gone".
- **The runtime's facts cannot be misremembered.** A checkpoint that claimed a file was changed when it was not, or a test passed that never ran, is now impossible.
- **The backstop stops being the common case.** If elision and compaction are on, dropping exchanges at the window is the exception rather than the plan.

**Negative**

- **Rungs 1 and 2 can both fire on one round.** Elision runs first, as the cheaper one, and can leave nothing for the checkpoint to compact — which is the ladder working, and also a trigger that did not do what its threshold promised.
- **A checkpoint is lossy in the model's half.** Every compaction compounds the model's own omissions, which is why three without progress count as stuck rather than four.
- **Compaction costs a round**, and a checkpoint round on a small model can come back malformed. The runtime then compacts anyway with an empty checkpoint, because the ledger and the diff are the part that cannot be lost.
- **Progress is measured against the ledger, not against the work.** A Worker that fixes a test by rewriting the test to match the code makes no new file and no newly passing check, and will be called stuck.

**Effect on ADR-0015**

- The 70% trigger, the `write_checkpoint` call, the fixed checkpoint shape, the 40% limit, the three-compactions rule and "a Worker is not killed because its context is full" all stand.
- What is new is that elision runs before any of it, and that the checkpoint's two runtime-owned fields are filled by the runtime rather than asked for.
- The Developer conversation compaction is untouched.

**Neutral**

- Every threshold is `bench/config.json` configuration with defaults, and the defaults are the shipped ones with the switches off. They are expected to move once real runs are measured.
- The attempt outcome and its record live in memory for the run and in `result.json`; they are not persisted per task.

## Open Questions

- Should elision also rewrite the model's own reasoning, or only tool results?
- Should a checkpoint be kept across attempts for the same task, so a respawn starts from L1 rather than from a pack?
- Should the ladder be able to skip rung 2 for a task whose whole remaining work is one command?

## See Also

- [ADR-0015 — Workers Compact Their Own Context](0015-workers-compact-their-own-context.md)
- [ADR-0016 — Failed Attempts Are Respawned, Not Revised](0016-failed-attempts-are-respawned.md)
- [ADR-0017 — The Manager Compiles a Context Pack Per Task](0017-the-manager-compiles-a-context-pack-per-task.md)
- [ADR-0019 — A Retry Is Told What Failed, and a Finished Task Hands Off](0019-a-retry-is-told-what-failed-and-a-finished-task-hands-off.md)
- [Sweeps](../../bench/sweeps/README.md)