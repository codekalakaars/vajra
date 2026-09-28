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
| [0003](0003-task-scoped-permissions.md) | Worker permissions are scoped to the assigned task | Accepted |
| [0004](0004-manager-inspects-never-repairs.md) | The Manager inspects and escalates, never repairs | Accepted |
| [0005](0005-predefined-parallel-order.md) | Parallel order is predefined by the Developer, not derived at runtime | Accepted |
| [0006](0006-phase-one-is-mandatory.md) | Every submission opens with a mandatory Phase One of stubs and failing tests | Accepted |
| [0007](0007-test-verdict-contract.md) | Mechanical verdicts with expectation inversion, not a boolean | Accepted |
| [0008](0008-mutation-as-criterion.md) | Mutation scoring is a first-class criterion | Accepted |
| [0009](0009-opencode-zen-is-the-only-provider.md) | OpenCode Zen is the only LLM provider; one `OPENCODE_API_KEY` at `0600` | Accepted |
| [0010](0010-every-role-is-an-llm-agent.md) | Developer, Manager and Worker are all LLM agents, each with its own model | Accepted |
| [0011](0011-tiered-success-criteria.md) | Success criteria are tiered — behavioural, structural, review — and the mechanical floor is never dropped | Accepted |

These first eight are mutually reinforcing. Each closes a hole the others would otherwise leave: 0001 centralizes planning authority, 0002 keeps execution attributable, 0003 bounds the damage a Worker can do, 0004 keeps verification independent of the work being verified, 0005 keeps the parallel structure a planning decision rather than a runtime one, 0006 makes "done" executable before any implementation is written, 0007 makes that executability checkable rather than nominal, and 0008 asks whether the check has teeth at all.

The pair 0006 and 0007 is deliberately scoped to be language-neutral: Phase One defines *what* must exist before implementation, and JUnit XML ingestion establishes that any language can produce the evidence.

0009 stands apart from that set. The first eight govern the harness; 0009 governs the shipped CLI's outside edge — which vendor it talks to, and where the one credential lives. It is recorded as an ADR because the provider is the one thing a user cannot work around: every other decision here is internal to a run.

0010 answers a question 0009 deliberately left open. 0009 fixes the provider; 0010 says the three reasoning roles are all agents and each picks its own model within that one provider. The two do not conflict — 0009 constrains the credential and the endpoint, 0010 constrains model selection — and the distinction matters, because a *provider* per role would reopen everything 0009 closed.

0011 answers the objection that 0006 and 0007 make the harness unusable for ordinary work. Both are strict: every task must be provable by a command that fails then passes. That is right for behaviour and unavailable for a good deal of real work — a new endpoint, a new screen — so 0011 adds a **structural** tier rather than dropping the floor. It also fixes two things 0005 left open in practice: the parallelism ceiling belongs to the host rather than to a constant, and a Worker's death is contained to its own task.

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
