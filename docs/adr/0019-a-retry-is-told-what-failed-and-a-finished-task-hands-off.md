# ADR-0019: A Retry Is Told What Failed, and a Finished Task Hands Off

## Status

Accepted. Implements the context side of [ADR-0016](0016-failed-attempts-are-respawned.md).

## Date

2026-10-02

## Context

[ADR-0016](0016-failed-attempts-are-respawned.md) says every failed attempt ends its Worker and the Manager respawns the task with the task, the last checkpoint and the findings. The shipped code does the respawn and not the rest: a failed attempt is rolled back and the task runs again from the same prompt. The new Worker is told nothing, so it can repeat the same mistake, and the files the last attempt got right are rolled back with the ones it got wrong.

[ADR-0014](0014-peer-aware-workers-and-access-requests.md) says a Worker can see "structured handoffs published by completed tasks", and leaves open "how much of the peer view goes into a Worker's context by default". What a completed task publishes was never defined, so in practice nothing is published: a dependent task re-reads the files its dependency wrote and works out what changed.

Both records have the same shape and the same danger. They are mostly things the runtime knows and the model is asked for: which files changed, which commands ran and what they exited with. A model asked to recall those will report its intentions — the edit it meant to make, the test it believed would pass — and the next Worker inherits a confident and wrong account.

## Decision

**Every attempt leaves an `AttemptRecord`, and every completed task publishes a `Handoff`. Both are mostly the runtime's.**

An attempt record holds its outcome (`done`, `failed_verification`, `stuck`, `error`, `timeout`, `budget`, `interrupted`), the failing command with its exit code and the tail of what it printed, its last checkpoint, the files it wrote, its diff and its closing words. The outcome, the files and the command come from the ledger the runtime kept as it happened; only the checkpoint's judgements and the closing words are the model's.

**A failed attempt's diff is captured before the rollback.** The rollback is what makes the retry start from a clean tree, and it is also what would erase the evidence of what the attempt tried. The diff is read off disk while the changes are still there.

**With `respawnContext` on, a retry gets a *Previous attempt* section**: the outcome, the failing command and the output it printed, the last checkpoint in full, the diff of what it tried within `respawnDiffChars`, and one line per earlier attempt. It is section 3 of the pack ([ADR-0017](0017-the-manager-compiles-a-context-pack-per-task.md)), or appended to the first user message when there is no pack.

**The failed conversation is never passed on.** Not its tool results, not its reasoning, not a summary of it. ADR-0016's reason holds: a Worker shown the reasoning that produced a failing change defends or patches it rather than reconsidering. The checkpoint is the part that was written to be read by exactly the next attempt; the conversation is not.

**A completed task publishes what only it can know about what it built.** Its handoff is:

| Field | Source | Holds |
|-------|--------|-------|
| `filesWritten` | runtime, from the ledger | every file the attempt changed |
| `interfaces` | runtime, from each file's before and after | the exported declarations added, changed or removed |
| `summary` | the Worker, capped at `handoffSummaryChars` | what it changed that a task building on it cannot work out from the diff |

The interfaces are compared as declaration lines between the file before and the file after, so a declaration whose body changed is correctly left out and one that was removed is reported as removed — a caller reading only interfaces has to know the thing it was told about no longer exists.

**A dependent gets a direct dependency's handoff in full and a transitive one's interfaces only.** The full record of a task two steps away describes code written against a tree this task is not looking at, and the declarations it established are what a caller two steps away actually needs.

## Consequences

**Positive**

- **A retry starts with the evidence instead of the prompt.** The most expensive kind of repeat — the one that rediscovers the same failing check — becomes the least likely.
- **Partial understanding survives.** What the last attempt got right is in the record even though its changes were rolled back.
- **A handoff is not a summary.** The file list and the interfaces cannot be wrong, because the model never writes them.
- **One code path.** A Worker ends the same way whether it completed, failed a check, went stuck, crashed or timed out.

**Negative**

- **Rollback and records disagree.** The retry is told about code that is no longer on disk. The record says so explicitly, but a Worker may still try to build on it.
- **A rollback is still the wrong default for a root-cause failure.** These records make a bad approach *legible*; they do not make it sound.
- **Interfaces are lines, not semantics.** A rename shows as a removal and an addition. A changed signature that keeps its declaration line is invisible to a dependent.
- **Respawn context costs prompt on every retry**, including retries that fail for a reason the previous attempt had nothing to do with.

**Effect on ADR-0014**

- ADR-0014 already called for *structured* handoffs rather than free text, so nothing in it is amended. This is what that sentence now means, and it answers its open question about how much of the peer view goes into a Worker's context by default: a dependent's pack carries its direct dependencies' records and nothing else.

**Effect on ADR-0016**

- The task, the checkpoint and the findings ADR-0016 requires are now all delivered. The findings are the failing command and its output; the checkpoint is the last one the attempt wrote.
- ADR-0016's "keep the failed attempt's changes" is still not what the shipped code does: a failed attempt is still rolled back. The diff is captured first so the next attempt has the evidence, and whether to stop rolling back is a separate decision this ADR does not take.

**Neutral**

- Attempt records and handoffs live in memory for the run and in `result.json`. They are not persisted with the session: a handoff names files that the next run will change again.
- `respawnContext` and the two caps are `bench/config.json` keys, defaulted off, so a run's behaviour is unchanged until they are turned on and measured.

## Open Questions

- Should a failed attempt's changes be kept rather than rolled back, as ADR-0016 describes?
- Should a handoff be stored per task and re-read at dispatch, so a dependent sees the declarations as they are now rather than as they were?
- Should the previous-attempt block include the harness commands the attempt ran, or only the failing one?

## See Also

- [ADR-0014 — Peer-Aware Workers and Access Requests](0014-peer-aware-workers-and-access-requests.md)
- [ADR-0016 — Failed Attempts Are Respawned, Not Revised](0016-failed-attempts-are-respawned.md)
- [ADR-0017 — The Manager Compiles a Context Pack Per Task](0017-the-manager-compiles-a-context-pack-per-task.md)
- [ADR-0018 — Compaction Is a Ladder](0018-compaction-is-a-ladder.md)