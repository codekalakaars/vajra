# Permission Specification

## Purpose

This document defines the formal permission schema. Field definitions only — rationale lives in [Permissions](../permissions/README.md).

## Table of Contents

- [Permission Schema](#permission-schema)
- [File Rules](#file-rules)
- [Derivation from a Task](#derivation-from-a-task)
- [Access Grants](#access-grants)
- [Ownership Records](#ownership-records)
- [Validation Rules](#validation-rules)

## Permission Schema

```json
{
  "taskId": "task_01H...",
  "allowedFiles": [
    "src/agents/worker.ts",
    "src/agents/worker.test.ts"
  ],
  "readOnlyFiles": [
    "src/agents/types.ts",
    "tsconfig.json"
  ],
  "blockedFiles": [
    "**",
    "!src/agents/worker.ts",
    "!src/agents/worker.test.ts"
  ],
  "allowNetwork": false
}
```

```typescript
interface TaskPermissions {
  taskId: string;
  allowedFiles: string[];
  readOnlyFiles: string[];
  blockedFiles: string[];
  allowNetwork: boolean;
}
```

## File Rules

| Field | Meaning |
|-------|---------|
| `allowedFiles` | Paths the Worker may create or modify. Derived from `task.targetFiles` plus the task's `write` grants. |
| `readOnlyFiles` | Paths the Worker may read but not modify. Derived from `task.readOnlyFiles` plus the task's `read` grants. |
| `blockedFiles` | Paths the Worker may not access at all. |
| `allowNetwork` | Whether outbound network access is permitted. Defaults to `false`. |

`blockedFiles` is an explicit deny list, evaluated with highest precedence — a path matching `blockedFiles` is denied even if it also appears in `allowedFiles`.

**Assumption:** `blockedFiles` supports glob patterns with `!` negation, as in the example above, so a whole-repo deny can be expressed as `"**"` with specific carve-outs. If a simpler exact-path model is preferred, this collapses to a single `"**"` sentinel with the allow lists doing all the work.

Precedence, highest first:

1. `blockedFiles` — explicit deny. Always wins.
2. `allowedFiles` — write access.
3. `readOnlyFiles` — read access.
4. Everything else — denied.

## Derivation from a Task

Permissions are never authored directly. They are computed from the task and the task's recorded access grants ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)):

```typescript
function derivePermissions(task: Task, grants: AccessGrant[]): TaskPermissions {
  const active = grants.filter(g => g.taskId === task.id && g.decision === "granted");
  const writeGrants = active.filter(g => g.mode === "write").map(g => g.file);
  const readGrants = active.filter(g => g.mode === "read").map(g => g.file);
  const allowedFiles = union(task.targetFiles, writeGrants);
  return {
    taskId: task.id,
    allowedFiles,
    readOnlyFiles: difference(union(task.readOnlyFiles ?? [], readGrants), allowedFiles),
    blockedFiles: buildDenyList(allowedFiles),
    allowNetwork: false,
  };
}
```

Permissions are re-derived each time a grant is recorded, and withdrawn in full when the task reaches a terminal state.

This is a security property, not a convenience. Only the Developer writes tasks, and only the Manager records grants. Permissions are a pure function of those two records, so a Worker has no path to widening its own access except by asking, and the answer is on the record before it takes effect.

**Assumption:** `read` grants feed `readOnlyFiles`. ADR-0014 leaves open whether a grant is ever read-only.

`allowNetwork` is currently always `false`; see [Security Model](../permissions/security-model.md#network-controls) for the open decision.

## Access Grants

Every decision on an access request is recorded, whether or not it grants anything.

```typescript
type AccessDecision = "granted" | "denied" | "not_needed" | "freeze" | "continue_meanwhile";

interface AccessGrant {
  taskId: string;          // the requesting task
  file: string;            // normalized path
  mode: "write" | "read";
  reason: string;          // the Worker's stated reason
  decision: AccessDecision;
  decidedAt: string;       // ISO timestamp
}
```

| `decision` | File state at decision | Effect |
|------------|-----------------------|--------|
| `granted` | Free, or released by its owner | File added to the task's permissions; the task takes ownership of it for a `write` grant |
| `denied` | Free | No change; the Worker proceeds without the file |
| `not_needed` | Owned by another active task | No change; the Worker proceeds without the file |
| `freeze` | Owned by another active task | Task moves to `frozen`; a `granted` record follows when the file is released |
| `continue_meanwhile` | Owned by another active task | Task stays `in_progress`; a `granted` record follows when the file is released |

Only `granted` records feed [derivation](#derivation-from-a-task). Grant records are part of the audit log and are shown in the Manager's review of the task.

## Ownership Records

Ownership is tracked separately from permissions, because it is about concurrency rather than access.

```typescript
interface FileOwnership {
  file: string;
  taskId: string;
  workerId: string;
  acquiredAt: string;
}
```

Rules:

- Acquiring ownership of a file already owned by a non-terminal task is refused. This applies to grants as well as to assignment.
- A `write` grant acquires ownership of the granted file for the requesting task.
- A task that needs a file owned by another task may only wait for it (`freeze` or `continue_meanwhile`). The wait is recorded as an edge from the waiting task to the owning task.
- A wait that would close a cycle in those edges is refused. The Manager agent must choose another decision or escalate.
- When an owner releases a file that a task is waiting on, ownership passes to the waiting task and a `granted` record is written. A frozen task is resumed.
- A frozen task that waits longer than its task timeout is escalated, and the task becomes `blocked`.
- Ownership, including ownership acquired through grants, is released when the task reaches a terminal state.
- Ownership is not inherited when permissions are withdrawn and re-provisioned for a new task.

**Assumption:** when several tasks wait on one file, it passes to them in the order their waits were recorded.

## Validation Rules

1. `taskId` must reference an existing task.
2. `allowedFiles` must be non-empty and must equal `task.targetFiles` ∪ the task's `write` grants.
3. `readOnlyFiles` must not intersect `allowedFiles`.
4. `blockedFiles` must not exclude any path in `allowedFiles` — otherwise the permission set is self-contradictory and the task cannot be executed.
5. All paths must be normalized and free of `..` traversal.
6. `allowNetwork` must be `false` unless explicitly granted by the Manager.
7. A grant must never give a task a file owned by another active (non-terminal) task.
8. A grant must be recorded as an `AccessGrant` before it takes effect. Permissions are re-derived from the record, never widened directly.
9. A grant belongs to one task and is withdrawn when that task reaches a terminal state.

Rule 4 is checked at provisioning time, so a contradiction surfaces as a failed assignment rather than a Worker that mysteriously cannot write its own target file.

## See Also

- [Task Specification](task-spec.md)
- [Agent Specification](agent-spec.md)
- [Permissions](../permissions/README.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](../adr/0014-peer-aware-workers-and-access-requests.md)
- [Security Model](../permissions/security-model.md)
