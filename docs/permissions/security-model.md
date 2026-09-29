# Security Model

## Purpose

This document describes how Vajra contains and observes agent execution — sandboxing, filesystem controls, secrets handling, network controls, and audit logs.

## Table of Contents

- [Threat Model](#threat-model)
- [Sandboxing](#sandboxing)
- [Filesystem Controls](#filesystem-controls)
- [Secrets Handling](#secrets-handling)
- [Network Controls](#network-controls)
- [Audit Logs](#audit-logs)
- [Open Questions](#open-questions)

## Threat Model

Vajra assumes agents are **fallible rather than adversarial**. The design does not attempt to defend against a malicious agent; it assumes a confused, careless, or subtly wrong one and bounds the damage that follows.

The properties that matter:

| Property | Why it matters |
|----------|----------------|
| **Bounded blast radius** | A wrong Worker cannot damage the codebase outside its task |
| **No privilege accumulation** | A compromised task does not confer access to the next one |
| **Independent inspection** | Errors are caught by a role that did not produce the work — the Manager's verification ladder and review ([ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md)) |
| **Accountability** | Every action is attributable to a role and a task |

**Assumption:** An agent that is genuinely adversarial — one actively trying to exfiltrate data or subvert the Manager — is out of scope. The controls below limit accidental and careless failure, not a coordinated attack. If adversarial agents are ever in scope, this model needs rethinking from the ground up.

## Sandboxing

Each Worker executes inside a confined environment for the duration of its task.

- The environment is provisioned at assignment and torn down when the task reaches a terminal state. The Manager kills the Worker at its task's verdict, whether `accepted` or `rejected`, so no Worker process outlives its task ([ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md)).
- The Worker has no visibility of other Workers' environments. It sees its peers only through the Manager's read-only view of the run — tasks, their status and holders, owned files, and published handoffs ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)). It never sees another Worker's conversation or intermediate edits.
- A frozen Worker keeps its environment and its own files while it waits; it is not torn down until its task ends.
- The Worker cannot persist anything beyond its task, except through the files it is permitted to write.

**Assumption:** Sandboxing is per-task and short-lived — created on assignment, destroyed on completion — rather than a persistent sandbox per Worker. This follows from permissions being re-derived per task, but it has a real cost in startup latency that would need measuring.

TODO: Define the isolation mechanism and its strength per platform. Record the decision as an ADR once chosen.

## Filesystem Controls

Filesystem access is the primary control surface, and it is expressed entirely through the task.

- **Write** access is limited to the task's target files plus its recorded write grants. See [Task-Scoped Permissions](README.md#task-scoped-permissions).
- **Grants** widen the scope only through a Manager decision that is recorded before it takes effect. A grant is never given for a file another active task owns, and it is withdrawn when the task ends. See [Access Requests](README.md#access-requests).
- **Read** access is broader, since implementation requires reading neighbouring code.
- **Ownership** prevents two active Workers writing the same file. See [File Ownership](README.md#file-ownership).
- Writes outside the task's scope — declared files plus grants — are detected and cause rejection, whether or not the environment would have prevented them.

A Worker that modifies a file that is neither declared nor granted fails inspection regardless of whether the change was helpful. The scope is the contract; the only way to widen it is to ask.

**Assumption:** a grant is applied to the environment boundary as well as the tool surface, without restarting the Worker.

## Secrets Handling

Agents should never need raw secrets, so the model is to keep them out of reach rather than to filter them out of context.

- Secrets are not injected into a Worker's context.
- Secrets are not written into files a Worker may modify.
- If a task genuinely requires a credential, it is supplied through a scoped mechanism rather than the environment.

**Assumption:** The primary defence is non-injection, not redaction. A redaction pass over output is a useful backstop for the case where a secret is read from a file and echoed into a diff, but it is a safety net rather than the control.

TODO: Define whether output redaction is in scope, and if so what it operates on — diffs, reports, or all agent output.

## Network Controls

Network access is a meaningful risk surface because it is an exfiltration path that filesystem controls do not cover.

**Assumption:** Workers run without network access by default, and network-enabled tasks are the exception, granted explicitly per task and logged. The Manager holds this authority alongside the rest of permission provisioning.

TODO: Decide whether network access is denied outright for all Workers, or opt-in per task. If opt-in, define the mechanism.

## Audit Logs

Every consequential action should be attributable to a role and, where applicable, a task.

Expected coverage:

| Event | Recorded by |
|-------|-------------|
| Task created, finalized, submitted | Developer |
| Task assigned, permissions provisioned | Manager |
| Task state transitions | Worker, confirmed by Manager |
| Files written, and by which task | Worker |
| Verification ladder results, per rung | Manager (mechanical part) |
| Review verdict and each review round (`accepted`, `changes_requested`, `rejected`) | Manager (agent) |
| Access requests, grants, and decisions — task, file, mode, reason, decision | Manager |
| Freezes and resumes, and refused freezes (wait cycles) | Manager (mechanical part) |
| Worker kills, and the verdict that caused them | Manager (mechanical part) |
| Escalation raised and answered | Manager, Developer |

**Assumption:** The audit log is append-only and is the system's source of truth for reconstructing what happened, including after a task's context is destroyed. It is not user-facing telemetry.

TODO: Define retention, storage, and access. Confirm whether the log is the same artifact as the observability stream in [Runtime](../runtime/README.md#observability) or a separate, more durable one.

## Open Questions

- [ ] Is the sandbox per-task or per-Worker? (Assumed per-task above.)
- [ ] Is network access denied by default, opt-in, or unrestricted?
- [ ] Is output redaction in scope?
- [ ] How are audit logs retained, and who can read them?
- [ ] What is the isolation mechanism and its strength on each supported platform?
- [ ] Should a Worker be able to read files outside its target set at all?
- [ ] Should some paths (configuration, lockfiles, migrations) never be grantable without Developer approval? (Open in [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).)

## See Also

- [Permissions](README.md)
- [Runtime](../runtime/README.md)
- [Execution](../execution/README.md)
