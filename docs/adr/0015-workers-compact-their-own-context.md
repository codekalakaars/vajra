# ADR-0015: Workers Compact Their Own Context

## Status

Accepted.

## Date

2026-09-30

## Context

A Worker's conversation grows with every tool call: each file it reads, each command it runs, and each step of reasoning stays in context. A task of any real size eventually fills the model's window. Today the Worker has no answer to that. Its loop stops at a fixed budget of 100 tool calls whatever the window holds, and the conversation is never trimmed. The Developer already drops old messages when its window fills; the Worker has nothing equivalent.

Two answers were considered. The first kills the Worker when its context is full and starts a fresh one. That throws away a Worker that was making progress, and it makes a context limit look like a failure. The second lets the Worker shrink its own context and continue. Most of what fills a Worker's context is disposable: raw file contents it has already acted on, command output it has already read, and reasoning that led to edits already on disk.

The code a Worker writes does not have to stay in its context at all. Every edit goes to disk as it is made, so the context only needs to know *which* files changed. The Worker can read a file again if it needs the contents.

## Decision

**A Worker compacts its own context and keeps working.** It is not killed because its context is full.

**The runtime triggers compaction, not the model.** After every provider round, the runtime compares the round's prompt tokens with the Worker model's context window. At **70% of the window** it pauses the Worker and requires one call to a `write_checkpoint` tool. The runtime then replaces the conversation with:

1. the system prompt, the task and its brief, unchanged;
2. the checkpoint.

Raw tool output, file contents and earlier reasoning are dropped. The Worker resumes from the checkpoint.

**The checkpoint has a fixed shape**, so it can be validated and stored:

| Field | Holds |
|-------|-------|
| `filesChanged` | Paths only. Contents are on disk |
| `decisions` | Each decision made, with the reason |
| `done` | What is complete |
| `remaining` | What is left, in order |
| `lastVerification` | The last verification result the Worker saw, if any |
| `notes` | Anything else the next context needs |

Every checkpoint is stored with its task and a sequence number.

**A Worker that cannot compact usefully is stuck, and reports it.** A Worker is stuck when either of these is true:

- after compacting, the checkpoint alone takes more than **40% of the window**;
- it has compacted **3 times** with no progress in between. Progress means a new file written, or a verification step that failed before now passing.

A stuck Worker ends its attempt with outcome `stuck` and its last checkpoint. What happens next is the Manager's decision, under [ADR-0016](0016-failed-attempts-are-respawned.md).

**The tool-call budget stays, as a backstop.** It stops a Worker that loops without its context growing much. It is no longer the main limit on how long a Worker runs.

## Consequences

**Positive**

- **A long task no longer dies at an arbitrary limit.** A Worker can run for as long as it keeps making progress.
- **Compaction and respawn share one format.** The checkpoint a Worker writes for itself is the one its replacement receives ([ADR-0016](0016-failed-attempts-are-respawned.md)), so there is one handoff format rather than two.
- **Stuck is detected, not guessed.** "Compacting without progress" is measurable, and it separates a task that is big from a task that is going in circles.

**Negative**

- **Compaction loses information.** A checkpoint is the model's own summary, and it can omit something that mattered. Each compaction compounds this, which is part of why three compactions without progress count as stuck.
- **Compaction costs a round.** Writing the checkpoint is a model call that produces no code.
- **The trigger depends on reported usage.** The runtime needs the provider's prompt-token count for each round. A round with no usage reported cannot trigger compaction, so the tool-call budget is the only limit for that round.

**Neutral**

- The thresholds (70%, 40%, 3) are configuration with these defaults. They are expected to change once real runs are measured.
- The Developer's compaction, which drops old messages, is unchanged.

## Open Questions

- Should the 70% trigger depend on the window size, since 30% of a small window leaves very little room to work?
- Should the checkpoint include short excerpts of files the Worker is still editing, to save it a read after compaction?

## See Also

- [ADR-0002 — Single-Task Workers](0002-single-task-workers.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0016 — Failed Attempts Are Respawned, Not Revised](0016-failed-attempts-are-respawned.md)
