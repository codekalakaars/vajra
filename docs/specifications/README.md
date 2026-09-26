# Specifications

## Purpose

This section contains the formal, normative definitions for Vajra — schemas, state machines, and validation rules. These documents state *what* is true; ADRs state *why* it was decided that way.

## Table of Contents

- [Specifications](#specifications)
- [How to Write a Specification](#how-to-write-a-specification)
- [Relationship to Other Docs](#relationship-to-other-docs)

## Specifications

| Spec | Defines |
|------|---------|
| [Task Specification](task-spec.md) | `Task` schema, success criteria, state machine, validation rules |
| [Agent Specification](agent-spec.md) | Capabilities, restrictions, inputs, and outputs per role |
| [Permission Specification](permission-spec.md) | `TaskPermissions` schema, precedence, ownership, derivation |

## How to Write a Specification

1. State the schema or rule. No narrative rationale — that belongs in `adr/` or the conceptual docs.
2. Mark every inference with **Assumption:** so reviewers can tell settled rules from proposals.
3. Mark unknowns with `TODO` and prefer an explicit open-questions list over a vague inline marker.
4. Reference the conceptual doc for rationale, and the ADR for the decision behind it.
5. Include a validation section — a spec that cannot be checked is not a spec.

## Relationship to Other Docs

The documentation separates three kinds of statement, and mixing them is the main thing to avoid:

| Kind | Lives in | Answers | Example |
|------|----------|---------|---------|
| **Decision** | `adr/` | Why was it done this way? | Only the Developer creates tasks |
| **Concept** | `tasks/`, `execution/`, `permissions/`, `system-roles/`, `overview/` | What does it mean, and how does it behave? | A task is atomic and testable |
| **Normative detail** | `specifications/` | What exactly are the fields and rules? | `targetFiles: string[]` |

If a change alters a decision, write an ADR. If it alters meaning, update the conceptual doc. If it alters a field or rule, update the spec.

## See Also

- [ADRs](../adr/README.md)
- [Overview](../overview/overview.md)
- [Roadmap](../roadmap/README.md)
