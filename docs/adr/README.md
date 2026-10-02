# Architecture Decision Records

## Purpose

An ADR captures a significant architectural decision, the reason for it, and what follows from it — so that a future maintainer knows *why* the system works the way it does, not just *what* it does.

## Table of Contents

- [Format](#format)
- [Status Values](#status-values)
- [Index](#index)
- [When to Write One](#when-to-write-one)

## Format

```text
ADR-NNNN: Title

Status:    Proposed | Accepted | Superseded by ADR-NNNN
Date:      YYYY-MM-DD

Context:   What problem, what forces were in play.
Decision:  What was decided, stated plainly.
Consequences: What this makes easy, what it makes hard, what it forecloses.
```

The **Consequences** section is the one that earns the document. A decision without recorded costs is a decision nobody can evaluate later.

Numbering is sequential and never reused. A reversed decision gets a new ADR that supersedes the old one; the original stays in place.

## Status Values

| Status | Meaning |
|--------|---------|
| `Proposed` | Under discussion; not binding |
| `Accepted` | Binding on the implementation |
| `Superseded by ADR-NNNN` | Replaced; retained for history |

## Index

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-developer-only-task-creation.md) | Only the Developer creates tasks | Accepted |
| [0002](0002-single-task-workers.md) | Workers execute one task at a time | Accepted |
| [0003](0003-task-scoped-permissions.md) | Worker permissions are scoped to the assigned task | Accepted; scope-immutability rule superseded by [0014](0014-peer-aware-workers-and-access-requests.md) |
| [0004](0004-manager-inspects-never-repairs.md) | The Manager inspects and escalates, never repairs | Accepted; amended by [0013](0013-manager-verifies-reviews-and-retires-workers.md) |
| [0005](0005-predefined-parallel-order.md) | Parallel order is predefined by the Developer, not derived at runtime | Accepted |
| [0006](0006-phase-one-is-mandatory.md) | Every submission opens with a mandatory Phase One of stubs and failing tests | Superseded by [ADR-0012](0012-verification-ladder-replaces-phase-one.md) |
| [0007](0007-test-verdict-contract.md) | Mechanical verdicts with expectation inversion, not a boolean | Accepted; amended by [0012](0012-verification-ladder-replaces-phase-one.md) |
| [0008](0008-mutation-as-criterion.md) | Mutation scoring is a first-class criterion | Accepted |
| [0009](0009-opencode-zen-is-the-only-provider.md) | OpenCode Zen is the only LLM provider; one `OPENCODE_API_KEY` at `0600` | Accepted |
| [0010](0010-every-role-is-an-llm-agent.md) | Developer, Manager and Worker are all LLM agents, each with its own model | Accepted |
| [0011](0011-tiered-success-criteria.md) | Success criteria are tiered — behavioural, structural, review — and the mechanical floor is never dropped | Accepted |
| [0012](0012-verification-ladder-replaces-phase-one.md) | A verification ladder — compiles, runs, dependencies, serves, tests — replaces Phase One | Accepted |
| [0013](0013-manager-verifies-reviews-and-retires-workers.md) | The Manager has a mechanical part and an LLM part; it verifies, reviews with bounded rounds, and kills every Worker at its verdict | Accepted; amended by [0016](0016-failed-attempts-are-respawned.md) |
| [0014](0014-peer-aware-workers-and-access-requests.md) | Workers are peer-aware through the Manager and may request more access | Accepted |
| [0015](0015-workers-compact-their-own-context.md) | Workers compact their own context at 70% of the window, into a fixed checkpoint, and report `stuck` when compaction stops helping | Accepted |
| [0016](0016-failed-attempts-are-respawned.md) | Every failed attempt ends its Worker; the Manager respawns the task with the checkpoint and findings, keeping the attempt's changes | Accepted |
| [0017](0017-the-manager-compiles-a-context-pack-per-task.md) | The Manager compiles a deterministic, budgeted context pack per task at dispatch, in the Worker's system prompt | Accepted |
| [0018](0018-compaction-is-a-ladder.md) | Compaction is a ladder — elision, then a runtime-checkpointed compaction, then stuck; the trigger is the runtime's | Accepted; amends [0015](0015-workers-compact-their-own-context.md) |
| [0019](0019-a-retry-is-told-what-failed-and-a-finished-task-hands-off.md) | A retry is told what the last attempt did and why it failed, and a completed task publishes a runtime-recorded handoff | Accepted; implements the context side of [0016](0016-failed-attempts-are-respawned.md) |

These first eight are mutually reinforcing. Each closes a hole the others would otherwise leave: 0001 centralizes planning authority, 0002 keeps execution attributable, 0003 bounds the damage a Worker can do, 0004 keeps verification independent of the work being verified, 0005 keeps the parallel structure a planning decision rather than a runtime one, 0006 made "done" executable before any implementation was written, 0007 makes verification checkable rather than nominal, and 0008 asks whether the check has teeth at all. 0006 has since been superseded by 0012, and 0003, 0004 and 0007 amended by 0012–0014.

0017–0019 are the context batches of 0015, 0016 and 0014, and they reinforce each other in the same way. 0017 says what a Worker is given before it starts; 0018 says what it does with its context once the window fills; 0019 says what one attempt leaves for the next one and what one task leaves for the next task. Between them every layer of a Worker's context has an owner and a rule: L0 is compiled and budgeted, L1 is runtime-checkpointed, L2 is elided before it is dropped, and L3 is on disk with a named call for getting it back.

0007 is deliberately scoped to be language-neutral: JUnit XML and TAP ingestion establish that any language can produce the evidence. It originally paired with 0006's Phase One, which defined *what* must exist before implementation; with Phase One gone, the same verdict contract now covers every rung of 0012's ladder.

0009 stands apart from that set. The first eight govern the harness; 0009 governs the shipped CLI's outside edge — which vendor it talks to, and where the one credential lives. It is recorded as an ADR because the provider is the one thing a user cannot work around: every other decision here is internal to a run.

0010 answers a question 0009 deliberately left open. 0009 fixes the provider; 0010 says the three reasoning roles are all agents and each picks its own model within that one provider. The two do not conflict — 0009 constrains the credential and the endpoint, 0010 constrains model selection — and the distinction matters, because a *provider* per role would reopen everything 0009 closed.

0011 answers the objection that 0006 and 0007 made the harness unusable for ordinary work. Both were strict: every task had to be provable by a command that fails then passes. That is right for behaviour and unavailable for a good deal of real work — a new endpoint, a new screen — so 0011 adds a **structural** tier rather than dropping the floor. It also fixes two things 0005 left open in practice: the parallelism ceiling belongs to the host rather than to a constant, and a Worker's death is contained to its own task.

0012 goes further than 0011 and removes Phase One. Instead of stubs and failing tests before any implementation, every task declares a verification ladder — compiles, runs, dependencies (stubbed or checked), serves, tests — which the Manager's mechanical part climbs after the Worker reports completion, stopping at the first failing rung. Every rung expects `pass`, so 0007's expectation inversion is needed only for a task explicitly declared as writing a failing test. The ladder's rungs map onto 0011's tiers.

0013 says what the Manager's inspection is made of. A mechanical part establishes facts — scheduling, permissions, the ladder — and an LLM part judges them, returning `accepted`, `changes_requested` or `rejected`. The model may reject a ladder pass but never accept a ladder fail. `changes_requested` sends findings back to the same Worker for a bounded number of rounds, which amends 0004's rule that every problem is a Developer round trip; the Manager still never repairs. Every Worker is killed at its task's verdict.

0014 relaxes two isolation rules while keeping the one-writer guarantee. Workers get a read-only peer view through the Manager, with no lateral channel. A Worker that needs a file outside its task can ask for it: a free file may be granted, and an owned file is waited for (`freeze` or `continue_meanwhile`) or declared `not_needed`. This supersedes 0003's scope-immutability rule; permissions are still derived per task and withdrawn at its end.

0015 and 0016 are a pair. 0015 lets a Worker survive a full context by compacting it into a fixed checkpoint, and says when compaction has stopped helping. 0016 uses the same checkpoint when a Worker has to go: every failed attempt ends its Worker, and a fresh one continues from the checkpoint with the Manager's findings. That amends 0013, whose `changes_requested` returned findings to the same Worker.

## When to Write One

Write an ADR when a decision:

- Constrains what any role may do, or forbids something that seems reasonable.
- Has a cost that a future reader would not anticipate from the code.
- Would be hard to reverse once implemented.
- Is currently contested — a `Proposed` ADR records the disagreement, which is often more valuable than the resolution.

Do not write one for implementation details. Those belong in [Runtime](../runtime/README.md) and can change freely.

## See Also

- [Roadmap](../roadmap/README.md)
- [Overview](../overview/overview.md)
- [Specifications](../specifications/README.md)
