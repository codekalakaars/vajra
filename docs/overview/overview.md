# Overview

## Purpose

This is the first document a new contributor should read. It describes the core philosophy, agent hierarchy, execution model, and fundamental separation of responsibilities in the Vajra system.

## Table of Contents

- [Core Philosophy](#core-philosophy)
- [Fundamental Principle](#fundamental-principle)
- [Agent Hierarchy](#agent-hierarchy)
- [Every Role Is an LLM Agent](#every-role-is-an-llm-agent)
- [Execution Model](#execution-model)
- [Separation of Responsibilities](#separation-of-responsibilities)
- [The Task](#the-task)
- [Phase One](#phase-one)

## Core Philosophy

Vajra decomposes software work into small, testable, self-contained tasks and executes them through a strict hierarchy of roles in which **authority is centralized** and **execution is confined**.

Two properties follow from this and shape everything else:

- **Testable by construction.** A task is only valid if we already know which files it touches and how to tell whether it worked. If either is unknown, the task is not ready to be created.
- **Bounded blast radius.** A Worker operates only within the files its task declares, so a mistake cannot spread across the codebase.

## Fundamental Principle

> **Authority is centralized; execution is confined.**

Authority to create work lives in exactly one role (the Developer). Authority to decide *what runs and when* lives in exactly one role (the Manager). Execution lives in exactly one role (the Worker), and only ever within a task's declared scope.

No role may perform another role's function. When a role is blocked, it escalates upward — it does not reach sideways or act on its own.

## Agent Hierarchy

```
Human
  │  direction, finalizes tasks
  ▼
Developer ──── the only role that creates tasks
  │  submits tasks
  ▼
Manager ────── orchestrates, supervises, inspects
  │  assigns one task at a time
  ▼
Worker ─────── executes end to end, confined to the task
```

Traffic flows strictly downward, with one exception: **problems flow upward** from Worker to Manager to Developer, which responds by creating a new task.

| Role | Creates Tasks | Executes Tasks | Orchestrates | Talks to Human |
|------|:------------:|:--------------:|:------------:|:--------------:|
| Human | No | No | No | — |
| Developer | **Yes** | No | No | Yes |
| Manager | No | No | **Yes** | No |
| Worker | No | **Yes** (one at a time) | No | No |

## Every Role Is an LLM Agent

The three roles below the Human — **Developer, Manager and Worker — are all agents**: each is an LLM-backed instance of its role, and **each is configured with its own model**. The Human holds a role but is not an agent and has no model.

This is worth stating plainly because it settles three questions at once. What a Manager *is* — an agent like the others, not a special kind of rule engine. Whether all three roles cost the same to run — they do not, and a submission that runs one Developer is not comparable to a plan that runs four Workers. And whether one model for the whole system is acceptable — it is not, because the three roles want different things from a model:

| Role | What it reasons about | What that demands |
|------|----------------------|---------------------|
| Developer | Requirement ambiguity, codebase shape, decomposition | Strong reasoning — it decides whether the work is specified correctly at all |
| Manager | Whether output satisfies stated criteria | Sound judgement — it is the only independent check in the system |
| Worker | One concrete edit inside a known scope | Capability and speed, multiplied by concurrency |

One global model forces a single compromise across all three. Configuring each separately means the expensive reasoning happens once, in the Developer, instead of on every task in a parallel fan-out.

Two boundaries hold regardless of configuration:

- **A model grants no authority.** Choosing a different model changes how well a role does its job, never what it may do. Every restriction in the table above and every prohibition in [System Roles](../system-roles/README.md) is enforced by the harness, not by the model.
- **The provider is not per role.** All three reach the one provider fixed by [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md); this is about which *model* each role uses. See [ADR-0010](../adr/0010-every-role-is-an-llm-agent.md) for the decision, its benefits, and the costs it accepts — chiefly that a run is no longer described by a single model id, and that configuring a weak Manager spends the independence [ADR-0004](../adr/0004-manager-inspects-never-repairs.md) depends on.

## Execution Model

1. The Human states a requirement to the Developer.
2. The Developer defines the tasks — each with exact target file paths and explicit success criteria.
3. The Developer structures them into phases and groups, and sets the parallelism limit and any file-overlap priority. This is a planning decision, not something the Manager works out later.
4. The Developer builds **Phase One** — stub files, then tests that fail. This gate is mandatory and runs before anything else. See [Phase One](../tasks/README.md#phase-one).
5. The Human finalizes the plan with the Developer.
6. The Developer submits it to the Manager.
7. The Manager runs Phase One, then works through the later phases, assigning one task at a time to an idle Worker with permissions scoped to that task.
8. Each Worker executes its task end to end and reports completion or failure.
9. The Manager inspects the output against the success criteria.
10. On success, the Manager reports to the Developer. On problems, the Manager reports the problems to the Developer, which creates new tasks to address them — and the cycle repeats.

Steps 7–9 repeat per task, across as many Workers and groups as the plan allows.

See [Execution](../execution/README.md) for detail and [System Roles](../system-roles/README.md) for per-role behavior.

## Separation of Responsibilities

| Role | Owns | Never does |
|------|------|-----------|
| Human | Direction, requirement definition, task finalization | Creates tasks directly, executes work, touches Workers |
| Developer | Task definition, decomposition, success criteria, stub files | Executes tasks, supervises Workers, bypasses the Manager |
| Manager | Assignment, supervision, inspection, escalation | Creates tasks, executes or repairs work, talks to Workers about scope |
| Worker | End-to-end execution of exactly one task | Creates tasks, self-schedules, exceeds its file scope, talks to Human/Developer |

The separation is what makes inspection meaningful: because the Manager neither writes the code nor defines the task, its inspection is an independent check rather than a self-review.

## The Task

The task is the atomic unit of work in Vajra.

- It is the **smallest** self-contained unit — there are no sub-tasks. A task is either executed whole or not at all.
- It is **testable**: the target files are known and the success criteria are defined before the task is created.
- It is **end-to-end**: a single Worker can complete it without further decomposition.

This is what makes the rest of the system tractable. Because a task cannot be too large, a Worker never has to ask for clarification mid-execution; because a task cannot be too vague, the Manager always has something concrete to inspect against; and because a task is atomic, a batch of them divides cleanly into groups that can run in parallel without ambiguity about who owns what.

## Phase One

Every submission opens with a mandatory Phase One, in two ordered steps:

1. **Stub files** — every declared target path exists, minimal but valid.
2. **Tests** — a runnable test per behaviour, currently failing.

No later phase starts until Phase One completes. See [Phase One](../tasks/README.md#phase-one) and [ADR-0006](../adr/0006-phase-one-is-mandatory.md).

The gate converts a task set from a description of intent into something mechanically checkable. A test that exists and fails is a precise definition of "done", present before any implementation is written — so after the gate, the Worker's job narrows to making a failing test pass.

It also front-loads discovery. Questions that would otherwise surface mid-implementation, when they are expensive, surface in Phase One, where the only cost is a stub and a test.

## See Also

- [Glossary](glossary.md)
- [Contributing Guide](contributing.md)
- [System Roles](../system-roles/README.md)
- [Tasks](../tasks/README.md)
- [ADRs](../adr/README.md)
