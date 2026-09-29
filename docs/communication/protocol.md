# Protocol

## Purpose

This document defines the message protocol between roles — the envelope, the message types per channel, and the rules governing them.

## Table of Contents

- [Message Envelope](#message-envelope)
- [Developer to Manager](#developer-to-manager)
- [Manager to Developer](#manager-to-developer)
- [Manager to Worker](#manager-to-worker)
- [Worker to Manager](#worker-to-manager)
- [Transport](#transport)
- [Versioning](#versioning)

## Message Envelope

Every message on every channel shares one shape.

```typescript
interface Message<T extends string, P> {
  id: string;            // unique message id
  type: T;               // message type
  from: Role;            // sender
  to: Role;              // recipient
  taskId?: string;       // required for any task-scoped message
  correlationId?: string; // links a report back to its trigger
  timestamp: string;     // ISO 8601
  payload: P;            // type-specific
}

type Role = "developer" | "manager" | "worker";
```

Field rules:

- `taskId` is **required** on every message that concerns a specific task, and forbidden on messages that do not (`task.submit` carries tasks in its payload).
- `correlationId` echoes the `id` of the message being responded to, so a Worker report can be traced to its assignment, and an `access.decision` to its `access.request`.
- Roles are declared explicitly in the envelope. There is no implicit sender — the hub topology in [Communication](README.md#communication-model) depends on knowing who addressed whom.
- `Role` has no `"human"` value. The Human talks only to the Developer, outside this protocol, and a message never has a Worker on both ends.

## Developer to Manager

### `task.submit`

Submits the execution plan, or a revision of it. Carries the phases, the tasks (each with its verification ladder), and the parallelism limit — because all three are properties of the whole submission, not of any single task.

Every `task.submit` carries a plan the Human approved. The Developer stays available while a run is active; a new Human request becomes a plan revision, approved by the Human, and submitted again with `task.submit`.

```typescript
interface TaskSubmitPayload {
  plan: TaskSubmission;   // phases, tasks, maxParallelGroups
  revision?: number;      // absent or 0 for the first plan; increments per revision
}
```

Rules for a revision:

- It never changes a task that is `assigned`, `in_progress`, `frozen`, or `verifying`, or one that has reached a terminal state. It may add tasks, and change or withdraw tasks that are still `pending`.
- It is rejected whole if it would change such a task.

**Assumption:** The plan is submitted whole, and each revision is also a whole plan. Incremental submission would leave phases, grouping, and the parallelism limit undefined, since all are global to the set. See [ADR-0005](../adr/0005-predefined-parallel-order.md). **Assumption:** a revision is marked by the `revision` counter; nothing else in the payload changes.

### `task.withdraw`

Removes a task that has not yet been assigned. Rejected if the task is already non-`pending`.

```typescript
interface TaskWithdrawPayload {
  taskId: string;
  reason: string;
}
```

## Manager to Developer

### `status.report`

```typescript
interface StatusReportPayload {
  summary: {
    pending: number;
    assigned: number;
    inProgress: number;
    frozen: number;
    verifying: number;
    completed: number;
    failed: number;
    rejected: number;
    blocked: number;
  };
  phases: Array<{
    phase: number;
    name: string;
    state: "queued" | "active" | "done";
    groups: Array<{
      group: string;
      state: "waiting" | "active" | "done";
      tasks: Array<{ taskId: string; state: TaskState }>;
    }>;
  }>;
  recent: Array<{ taskId: string; state: TaskState }>;
}
```

### `escalation.report`

Raised when a task fails, is rejected at review, or blocks. The Manager states the observation; it does not propose a fix.

```typescript
interface EscalationReportPayload {
  taskId: string;
  cause: "failed" | "rejected" | "blocked";
  observations: string[];   // what the Manager saw
  violatedCriteria?: string[]; // criteria not met, if known
  scopeViolations?: string[];  // files touched outside the task and its grants, if any
  reviewRounds?: number;       // changes_requested rounds used before the verdict
  ladder?: LadderResult;       // the last ladder result, if the ladder ran
  accessGrants?: AccessGrant[]; // every access decision recorded for the task
}
```

| `cause` | Raised when |
|---------|-------------|
| `failed` | The Worker sent `task.fail`, or the task could not be executed |
| `rejected` | The Manager agent's verdict was `rejected`, including when review rounds are exhausted |
| `blocked` | The Worker sent `task.blocked`; a frozen task waited past its task timeout; or an access request implied new work |

`LadderResult` is defined in [Task Specification](../specifications/task-spec.md#verification-ladder-schema); `AccessGrant` in [Permission Specification](../specifications/permission-spec.md#access-grants).

### `escalation.resolved`

```typescript
interface EscalationResolvedPayload {
  taskId: string;
  resolution: "revised" | "remediation" | "abandoned";
  newTaskId?: string;
}
```

## Manager to Worker

### `task.assign`

Assigns exactly one task. The payload carries everything the Worker needs; the Worker is not expected to have prior context.

```typescript
interface TaskAssignPayload {
  task: Task;
  permissions: TaskPermissions;
}
```

### `task.cancel`

```typescript
interface TaskCancelPayload {
  taskId: string;
  reason: string;
}
```

### `review.feedback`

Sent when the Manager agent's verdict is `changes_requested`. It goes to the same Worker, which keeps its context and its files. The task returns to `in_progress`. Findings state what is wrong, not how to fix it ([ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md)).

```typescript
interface ReviewFeedbackPayload {
  taskId: string;
  round: number;       // this round, starting at 1
  maxRounds: number;   // the task's maxReviewRounds
  findings: string[];  // what is wrong
  ladder: LadderResult; // the ladder result the review was based on
}
```

`accepted` and `rejected` verdicts are not sent to the Worker. The mechanical part kills the Worker on either; the kill is audit-logged, not a message.

### `access.decision`

The answer to an `access.request`. `correlationId` names the request.

```typescript
type AccessDecision = "granted" | "denied" | "not_needed" | "freeze" | "continue_meanwhile";

interface AccessDecisionPayload {
  taskId: string;
  file: string;
  decision: AccessDecision;
  reason: string;   // why; for not_needed, why the file is not required
}
```

| `decision` | Worker's next step |
|------------|--------------------|
| `granted` | Use the file; the task's permissions now include it |
| `denied` | Proceed without the file |
| `not_needed` | Proceed without the file |
| `freeze` | Save state and pause; the task is `frozen` until `task.resume` |
| `continue_meanwhile` | Keep working on parts that do not need the file; `task.resume` delivers it when released |

A `granted` decision is recorded as an `AccessGrant` before this message is sent. A `freeze` that would create a wait cycle is refused before it is sent.

### `task.resume`

Sent when a file a task was waiting on is released and granted: to a `frozen` task (which returns to `in_progress`) or to a task that continued meanwhile.

```typescript
interface TaskResumePayload {
  taskId: string;
  grantedFiles: string[];
}
```

### `team.status`

The read-only view of the run, sent in answer to `team.query`. It carries status and ownership, never another Worker's conversation or intermediate edits.

```typescript
interface TeamStatusPayload {
  tasks: Array<{
    taskId: string;
    title: string;
    state: TaskState;
    ownedFiles: string[];  // files owned while the task is active
    handoff?: TaskHandoffPayload; // published by a completed task
  }>;
}
```

**Assumption:** the project goal named in [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md) reaches the Worker with its assignment rather than in `team.status`.

## Worker to Manager

### `task.accept`

```typescript
interface TaskAcceptPayload {
  taskId: string;
}
```

### `task.progress`

Interim status only. Carries no scope change — a Worker that needs another file sends `access.request`, and one that has discovered the task is wrong sends `task.blocked`.

```typescript
interface TaskProgressPayload {
  taskId: string;
  note: string;
  filesTouched: string[];
}
```

### `task.complete`

The Worker claims success. This is a claim, not a verdict — the task moves to `verifying`, and stays open until the Manager runs the ladder and the Manager agent gives a verdict. After a `review.feedback`, the Worker sends `task.complete` again.

```typescript
interface TaskCompletePayload {
  taskId: string;
  filesWritten: string[];
  evidence: Array<{
    criterion: string;
    met: boolean;
    detail: string;
  }>;
}
```

### `task.fail`

```typescript
interface TaskFailPayload {
  taskId: string;
  reason: string;
  filesWritten: string[];
}
```

### `task.blocked`

```typescript
interface TaskBlockedPayload {
  taskId: string;
  blocker: string;
  needsFrom: "developer";
}
```

`needsFrom` is fixed to `developer` because only the Developer can resolve a blocker by producing a task, with the Human's approval. A Worker that only needs another file sends `access.request` instead; `task.blocked` is for a task that is wrong, or for work that belongs to no task the Worker holds.

### `access.request`

Asks for a file outside the task. The Manager checks ownership mechanically; the Manager agent decides ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)).

```typescript
interface AccessRequestPayload {
  taskId: string;
  file: string;
  mode: "write" | "read";
  reason: string;   // why the task needs the file
}
```

### `team.query`

Asks for the current read-only view of the run. The Worker may send it at any point during its task. Answered by `team.status`.

```typescript
interface TeamQueryPayload {
  taskId: string;
}
```

### `task.handoff`

Publishes a structured handoff for the Worker's own task. Peers see it in `team.status` once the task is completed. A Worker may publish a handoff only for its own task.

```typescript
interface TaskHandoffPayload {
  taskId: string;
  summary: string;
  interfaces?: string[];   // interfaces other tasks may rely on
  filesWritten: string[];
}
```

## Transport

TODO: Define the transport. The requirements are:

- Each channel must preserve ordering, so a Worker cannot receive a cancellation after it has already been assigned a new task, or a `task.resume` before the `access.decision` it follows.
- Messages must be attributable and loggable, feeding the audit log in [Security Model](../permissions/security-model.md#audit-logs).
- The Worker must be able to be confined at the environment level, which constrains the transport to something a sandbox can restrict.

TODO: Decide between a local subprocess channel and a network transport, and record the choice as an ADR.

## Versioning

TODO: Define how protocol versions are negotiated. At minimum:

- The envelope needs a version field, or the protocol needs a compatibility policy before any role other than the original implementer is written.
- A Worker running an older protocol version must not silently mis-parse an assignment.

## See Also

- [Communication](README.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](../adr/0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](../adr/0014-peer-aware-workers-and-access-requests.md)
- [Task Specification](../specifications/task-spec.md)
- [Permission Specification](../specifications/permission-spec.md)
- [Runtime](../runtime/README.md)
