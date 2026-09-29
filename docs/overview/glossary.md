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
- [Model](#model)
- [Task](#task)
- [Testable Task](#testable-task)
- [Phase](#phase)
- [Task Group](#task-group)
- [Parallel Order](#parallel-order)
- [Parallelism Limit](#parallelism-limit)
- [Dependency](#dependency)
- [Priority](#priority)
- [Success Criteria](#success-criteria)
- [Target Files](#target-files)
- [Verification Ladder](#verification-ladder)
- [Service Stub](#service-stub)
- [Task-Scoped Permissions](#task-scoped-permissions)
- [File Ownership](#file-ownership)
- [Access Request](#access-request)
- [Freeze](#freeze)
- [Peer View / Handoff](#peer-view--handoff)
- [Inspection](#inspection)
- [Review Round](#review-round)
- [Escalation](#escalation)
- [Remediation Task](#remediation-task)

## Agent

An LLM-backed instance of one of the agent roles — Developer, Manager or Worker. Each agent is configured with its own model, and no model grants authority beyond what its role already permits. The Human is not an agent. See [Every Role Is an LLM Agent](../specifications/agent-spec.md#every-role-is-an-llm-agent).

## Role

One of the four architectural positions in the system: Human, Developer, Manager, or Worker. A role carries a fixed set of responsibilities and prohibitions. Three of the four are held by agents; the Human is not one. See [System Roles](../system-roles/README.md).

## Human

The end user. Talks only to the Developer, supplies direction, approves every plan and plan revision before submission, and approves or rejects final results. Does not create tasks directly, execute work, or interact with the Manager or Workers.

## Developer

The only role permitted to create tasks. Acts only on its conversation with, and the approval of, the Human. Translates Human direction into testable tasks with defined target files, success criteria and a [verification ladder](#verification-ladder), and decides with the Human how to answer each escalation. Does not modify files.

## Manager

The orchestrator, in two parts. The **mechanical part** is deterministic code: it schedules tasks, provisions and withdraws permissions, holds file ownership, supervises and kills Workers, and runs the verification ladder. The **LLM part** (the Manager agent) reviews each task's results and gives a verdict — `accepted`, `changes_requested` or `rejected` — and decides access requests. Never creates or executes tasks, and never repairs work itself. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

## Worker

The execution role. Receives exactly one task from the Manager, completes it end to end within the permissions scoped to that task and any access granted to it, and reports the outcome. Sees its peers through a read-only [peer view](#peer-view--handoff) but cannot message them. Killed when its task reaches a verdict. Never creates tasks or self-schedules.

## Model

The LLM backing an agent. Each agent's model is configured independently, so a submission's cost and quality reflect three choices rather than one: a strong model on the Developer, a sound one on the Manager, and a capable fast one on Workers, whose cost is multiplied by concurrency. Selecting a model changes how well a role performs, never what it is permitted to do. The provider is not per role — see [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md) and [ADR-0010](../adr/0010-every-role-is-an-llm-agent.md).

## Task

The atomic unit of work. The smallest self-contained unit in the system — there are no sub-tasks.

## Testable Task

A task whose target files and success criteria are both known before the task is created. A task that is not testable is not ready to be created.

## Phase

A sequential stage of a submission. Phases run one after another; work within a phase may run in parallel. No phase is special: the mandatory Phase One was removed by [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

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

The exact file paths a task is permitted to modify. Defined upfront, even when the files do not yet exist. A declared target file that does not exist is created by the Worker whose task owns it.

## Verification Ladder

The ordered mechanical checks the Manager's mechanical part runs on a task after the Worker reports completion: **compiles**, **runs**, **dependencies** (services stubbed or confirmed healthy), **serves** (server started and probed), **tests**. Climbing stops at the first failing rung, and the report names the highest rung reached. The Developer declares the ladder per task; a rung that does not apply is declared not applicable with a reason, and at least one rung must apply. See [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

## Service Stub

A stand-in for a database or external service — an in-process fake, a container, or a recorded fixture — used by the ladder's dependencies rung when the real service is not checked instead. **Assumption:** the Manager's mechanical verifier provisions stubs; Workers do not write service stubs unless the Developer planned that as a task.

## Task-Scoped Permissions

The access granted to a Worker for the duration of one task: the task's target files plus any write access granted during the task. Derived per task and withdrawn when the task ends. See [Permissions](../permissions/README.md) and [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

## File Ownership

The rule that while a task is active, its target files and any files granted to it belong exclusively to that task's Worker, preventing two Workers from writing the same file. A file owned by another active task is never granted; the only path to it is waiting.

## Access Request

A Worker's request to the Manager for a file outside its task, with a reason. If the file is free, the Manager agent grants or denies it. If another active task owns it, the Manager agent answers `not_needed`, `freeze` or `continue_meanwhile`. Every grant is recorded and lasts only for the task. A request that implies new work is escalated to the Developer. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

## Freeze

An access-request response in which a Worker saves its state and pauses until a file it needs is released, then resumes with access granted. The task is `frozen` meanwhile. A freeze that would create a wait cycle is refused, and a Worker frozen past its task timeout is escalated.

## Peer View / Handoff

The **peer view** is a read-only view of the run a Worker can read and refresh through the Manager: the project goal, the plan's other tasks, each task's status and holder, the files each active task owns, and handoffs from completed tasks. A **handoff** is a structured summary a Worker may publish for its own task — what it did, interfaces it exposes, and files it wrote. Workers cannot see each other's conversations or message each other.

## Inspection

The Manager's evaluation of a completed task: the mechanical part runs the verification ladder, then the Manager agent reviews the ladder's evidence, the diff, the Worker's report and the success criteria, and gives a verdict. The agent may reject work the ladder passed; it may never accept work the ladder failed.

## Review Round

One `changes_requested` cycle: the Manager sends findings to the same Worker, which keeps its context and tries again. Rounds are bounded per task by `maxReviewRounds`. When they run out, the next non-accepting verdict is `rejected`. **Assumption:** the default is two rounds, so three attempts in total.

## Escalation

The upward report of a problem from Manager to Developer — a `rejected` task, a failure, a freeze timeout, or an access request that implies new work. The Developer decides with the Human whether to revise the plan, create a remediation task, or abandon the work.

## Remediation Task

A new task created by the Developer in response to an escalation. See [ADR-0001](../adr/0001-developer-only-task-creation.md).

## See Also

- [Overview](overview.md)
- [System Roles](../system-roles/README.md)
- [Tasks](../tasks/README.md)
