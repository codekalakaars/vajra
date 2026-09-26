# Glossary

## Purpose

This document defines key terms used throughout the Vajra documentation. Terms are listed in the order a new contributor encounters them.

## Table of Contents

- [Agent](#agent)
- [Role](#role)
- [Human](#human)
- [Developer](#developer)
- [Manager](#manager)
- [Worker](#worker)
- [Task](#task)
- [Phase](#phase)
- [Phase One](#phase-one)
- [Task Group](#task-group)
- [Parallel Order](#parallel-order)
- [Parallelism Limit](#parallelism-limit)
- [Dependency](#dependency)
- [Priority](#priority)
- [Testable Task](#testable-task)
- [Success Criteria](#success-criteria)
- [Target Files](#target-files)
- [Stub File](#stub-file)
- [Task-Scoped Permissions](#task-scoped-permissions)
- [File Ownership](#file-ownership)
- [Inspection](#inspection)
- [Escalation](#escalation)
- [Remediation Task](#remediation-task)

## Agent

An entity that assumes one of the architectural roles in order to participate in task creation, orchestration, or execution.

## Role

One of the four architectural positions in the system: Human, Developer, Manager, or Worker. A role carries a fixed set of responsibilities and prohibitions. See [System Roles](../system-roles/README.md).

## Human

The end user. Talks to the Developer, supplies direction, and finalizes tasks. Does not create tasks directly, execute work, or interact with Workers.

## Developer

The only role permitted to create tasks. Translates Human direction into testable tasks with defined target files and success criteria, creates stub files where needed, and creates remediation tasks in response to Manager escalations.

## Manager

The orchestrator. Receives tasks from the Developer, assigns them to Workers, supervises execution, inspects results against success criteria, and escalates problems to the Developer. Never creates or executes tasks, and never repairs work itself.

## Worker

The execution role. Receives exactly one task at a time from the Manager, completes it end to end within the permissions scoped to that task, and reports the outcome. Never creates tasks or self-schedules.

## Task

The atomic unit of work. The smallest self-contained unit in the system — there are no sub-tasks.

## Testable Task

A task whose target files and success criteria are both known before the task is created. A task that is not testable is not ready to be created.

## Phase

A sequential stage of a submission. Phases run one after another; work within a phase may run in parallel. Every submission has at least Phase One, and phase 1 is always Phase One. See [ADR-0006](../adr/0006-phase-one-is-mandatory.md).

## Phase One

The mandatory opening phase of every submission, containing stub-file tasks followed by test tasks that fail. Nothing else runs until it completes. Its purpose is to make success criteria executable before implementation begins. See [Phase One](../tasks/README.md#phase-one).

## Task Group

The unit of parallelism. A group is a set of tasks the Developer has determined may run concurrently. Every task belongs to exactly one group, and the partition is a planning decision made by the Developer, not inferred by the Manager. See [ADR-0005](../adr/0005-predefined-parallel-order.md).

## Parallel Order

The order in which work runs, predefined by the Developer rather than derived at runtime. Composed of phase order, `groupOrder`, dependencies, and priority.

## Parallelism Limit

The maximum number of groups in flight at once, declared by the Developer as part of the submission. A ceiling, not a target — the Manager runs as many groups as the limit allows.

## Dependency

An intra-group ordering constraint: the referenced tasks must reach `completed` before the dependent task becomes assignable. Dependencies express *logical* sequence and never cross a group boundary. See [Tasks](../tasks/README.md#task-dependencies).

## Priority

An inter-group ordering constraint, declared only between tasks that share a file. Priority expresses *resource contention* — which of two colliding tasks runs first. It is pairwise, not a total order. See [Tasks](../tasks/README.md#two-kinds-of-ordering).

## Success Criteria

The conditions that must hold for a task to be considered complete — for example a passing test, a satisfied assertion, or a review outcome. Defined by the Developer at task creation and used by the Manager during inspection.

## Target Files

The exact file paths a task is permitted to modify. Defined upfront, even when the files do not yet exist.

## Stub File

An empty or minimal file created at a target path so that a task has somewhere to write. Created by the Developer when needed; the path is still fixed in advance.

## Task-Scoped Permissions

The access granted to a Worker for the duration of one task, derived from that task's target files. Withdrawn when the task ends. See [Permissions](../permissions/README.md).

## File Ownership

The rule that while a task is in progress, its target files belong exclusively to that task's Worker, preventing two Workers from writing the same file.

## Inspection

The Manager's evaluation of a completed task's output against its success criteria.

## Escalation

The upward report of a problem from Manager to Developer, which the Developer answers by creating a remediation task.

## Remediation Task

A new task created by the Developer in response to an escalation. See [ADR-0001](../adr/0001-developer-only-task-creation.md).

## See Also

- [Overview](overview.md)
- [System Roles](../system-roles/README.md)
- [Tasks](../tasks/README.md)
