# Permission Specification

## Purpose

This document defines the formal permission schema. Field definitions only — rationale lives in [Permissions](../permissions/README.md).

## Table of Contents

- [Permission Schema](#permission-schema)
- [File Rules](#file-rules)
- [Derivation from a Task](#derivation-from-a-task)
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
| `allowedFiles` | Paths the Worker may create or modify. Derived from `task.targetFiles`. |
| `readOnlyFiles` | Paths the Worker may read but not modify. Derived from `task.readOnlyFiles`. |
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

Permissions are never authored directly. They are computed from the task:

```typescript
function derivePermissions(task: Task): TaskPermissions {
  return {
    taskId: task.id,
    allowedFiles: task.targetFiles,
    readOnlyFiles: task.readOnlyFiles ?? [],
    blockedFiles: buildDenyList(task.targetFiles),
    allowNetwork: false,
  };
}
```

This is a security property, not a convenience. Because only the Developer writes tasks, and permissions are a pure function of the task, a Worker has no path to widening its own access.

`allowNetwork` is currently always `false`; see [Security Model](../permissions/security-model.md#network-controls) for the open decision.

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

- Acquiring ownership of a file already owned by a non-terminal task is refused.
- Ownership is released when the task reaches a terminal state.
- Ownership is not inherited when permissions are withdrawn and re-provisioned for a new task.

## Validation Rules

1. `taskId` must reference an existing task.
2. `allowedFiles` must be non-empty and must equal `task.targetFiles`.
3. `readOnlyFiles` must not intersect `allowedFiles`.
4. `blockedFiles` must not exclude any path in `allowedFiles` — otherwise the permission set is self-contradictory and the task cannot be executed.
5. All paths must be normalized and free of `..` traversal.
6. `allowNetwork` must be `false` unless explicitly granted by the Manager.

Rule 4 is checked at provisioning time, so a contradiction surfaces as a failed assignment rather than a Worker that mysteriously cannot write its own target file.

## See Also

- [Task Specification](task-spec.md)
- [Agent Specification](agent-spec.md)
- [Permissions](../permissions/README.md)
- [Security Model](../permissions/security-model.md)
