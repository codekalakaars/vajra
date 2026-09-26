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
- `correlationId` echoes the `id` of the message being responded to, so a Worker report can be traced to its assignment.
- Roles are declared explicitly in the envelope. There is no implicit sender — the hub topology in [Communication](README.md#communication-model) depends on knowing who addressed whom.

## Developer to Manager

### `task.submit`

Submits the execution plan. Carries the phases, the tasks, and the parallelism limit — because all three are properties of the whole submission, not of any single task.

```typescript
interface TaskSubmitPayload {
  plan: TaskSubmission;   // phases, tasks, maxParallelGroups
}
```

**Assumption:** The plan is submitted whole. Incremental submission would leave phases, grouping, and the parallelism limit undefined, since all are global to the set. See [ADR-0005](../adr/0005-predefined-parallel-order.md).

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

Raised when a task fails, is rejected at inspection, or blocks. The Manager states the observation; it does not propose a fix.

```typescript
interface EscalationReportPayload {
  taskId: string;
  cause: "failed" | "rejected" | "blocked";
  observations: string[];   // what the Manager saw
  violatedCriteria?: string[]; // criteria not met, if known
  scopeViolations?: string[];  // files touched outside the task, if any
}
```

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

## Worker to Manager

### `task.accept`

```typescript
interface TaskAcceptPayload {
  taskId: string;
}
```

### `task.progress`

Interim status only. Carries no scope change — a Worker that has discovered the task is wrong sends `task.blocked` instead.

```typescript
interface TaskProgressPayload {
  taskId: string;
  note: string;
  filesTouched: string[];
}
```

### `task.complete`

The Worker claims success. This is a claim, not a verdict — the task remains open until the Manager inspects it.

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

`needsFrom` is fixed to `developer` because only the Developer can resolve a blocker by producing a task.

## Transport

TODO: Define the transport. The requirements are:

- Each channel must preserve ordering, so a Worker cannot receive a cancellation after it has already been assigned a new task.
- Messages must be attributable and loggable, feeding the audit log in [Security Model](../permissions/security-model.md#audit-logs).
- The Worker must be able to be confined at the environment level, which constrains the transport to something a sandbox can restrict.

TODO: Decide between a local subprocess channel and a network transport, and record the choice as an ADR.

## Versioning

TODO: Define how protocol versions are negotiated. At minimum:

- The envelope needs a version field, or the protocol needs a compatibility policy before any role other than the original implementer is written.
- A Worker running an older protocol version must not silently mis-parse an assignment.

## See Also

- [Communication](README.md)
- [Task Specification](../specifications/task-spec.md)
- [Permission Specification](../specifications/permission-spec.md)
- [Runtime](../runtime/README.md)
