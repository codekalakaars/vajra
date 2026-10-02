# Worker

## Purpose

This document describes the Worker role — the single-task principle, peer awareness, access requests, responsibilities, and limitations.

## Table of Contents

- [Worker Agent](#worker-agent)
- [Single Task Principle](#single-task-principle)
- [Peer Awareness](#peer-awareness)
- [Access Requests](#access-requests)
- [Responsibilities](#responsibilities)
- [Limitations](#limitations)

## Worker Agent

The Worker is the execution engine of the system. Each Worker receives one task from the Manager and completes it end to end. It is killed when its task reaches a verdict, `accepted` or `rejected`. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

## Single Task Principle

A Worker executes **one task at a time**. This principle exists because:
- It keeps Worker state simple — at most one active task.
- It ensures focused, end-to-end completion before moving on.
- It gives the Manager full control over assignment and scheduling.

On a `changes_requested` verdict, the Worker is killed and the task is respawned with a fresh Worker: the task unchanged, the last checkpoint, and the Manager's findings. The failed attempt's conversation is never handed over. Freezing and continuing after an access request do happen inside the Worker's own task. See [ADR-0002](../adr/0002-single-task-workers.md), [ADR-0016](../adr/0016-failed-attempts-are-respawned.md) and [ADR-0019](../adr/0019-a-retry-is-told-what-failed-and-a-finished-task-hands-off.md).

## Its Own Context

A Worker's conversation is its own to manage, and the runtime manages the parts it can measure:

- **Before the first round**, the Worker is given a compiled context pack: its task, what "done" means, the code it will change with its anchors in the current file, the contracts it produces or consumes, its scope, its dependencies' handoffs, its context excerpts and the project's build and test commands. Compiled by the runtime, not written by a model. See [ADR-0017](../adr/0017-the-manager-compiles-a-context-pack-per-task.md).
- **As its context fills**, the runtime first rewrites the tool results that are stale — a read it has since edited, a command it has since re-run, a search it has already read — and then, if that is not enough, compacts the conversation into a checkpoint the Worker writes. The Worker does not choose to compact, and it cannot compact instead of working. See [ADR-0018](../adr/0018-compaction-is-a-ladder.md).
- **When neither is enough**, the Worker ends its attempt as `stuck` and the Manager respawns it.

Every attempt ends as one of `done`, `failed_verification`, `stuck`, `error`, `timeout`, `budget` or `interrupted`, with what it wrote, what failed and its closing words. The file list and the commands come from the harness, not from the Worker.

## Peer Awareness

A Worker can read, through the Manager, a read-only view of the run and refresh it during its task:

- the project goal and the plan's other tasks;
- each task's status and which Worker holds it;
- the files each active task owns;
- structured handoffs published by completed tasks.

A Worker may publish a structured handoff for its own task: a summary, the interfaces it exposes, and the files it wrote.

A Worker cannot see other Workers' conversations or intermediate edits, cannot message another Worker, and cannot change any other task. There is no lateral channel. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

## Access Requests

A Worker that needs a file outside its task sends an access request to the Manager, naming the file and the reason. The Manager answers:

| Decision | What the Worker does |
|----------|----------------------|
| `granted` | Writes the file for the rest of the task |
| `denied` | Proceeds without it |
| `not_needed` | Proceeds without it; the Manager explains why |
| `freeze` | Saves its state and pauses; resumes with access when the file is released |
| `continue_meanwhile` | Keeps working on parts of its task that do not need the file; access is granted when the file is released |

A grant lasts only for the task. A request that implies new work is escalated to the Developer instead. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

## Responsibilities

- Execute the assigned task end to end, including creating any declared target file that does not exist yet.
- Stay within the permissions and scope of the assigned task and its grants.
- Request access through the Manager when a file outside the task is needed.
- Report completion or failure back to the Manager, and address review findings when changes are requested.

## Limitations

- Cannot create tasks.
- Cannot see or pick up additional tasks.
- Cannot interact directly with the Human, the Developer, or other Workers.
- Cannot change any task other than its own.
- Permissions are confined to the assigned task and the access granted to it, and are withdrawn when the task ends.

## See Also

- [Manager](manager.md)
- [Tasks](../tasks/README.md)
- [ADR-0002](../adr/0002-single-task-workers.md)
- [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)
