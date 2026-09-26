# Contributing Guide

## Purpose

This document explains how to contribute to Vajra — to the code and to the documentation.

## Table of Contents

- [Documentation First](#documentation-first)
- [Documentation Conventions](#documentation-conventions)
- [Changing the Model](#changing-the-model)
- [Code Contributions](#code-contributions)
- [Review](#review)

## Documentation First

The conceptual model is documented before it is implemented, and the documentation is the specification. Code is expected to match the docs, not the other way round.

Practical consequence: **if you change the architecture, the docs change in the same pull request.** A change to the role model, the task model, the permission model, or the message protocol is not complete without its documentation.

For a change that is deliberately speculative, mark it. An assumption written as fact is worse than no documentation, because the next reader cannot tell which parts to trust.

## Documentation Conventions

Every document has:

- A **Purpose** section stating what the document is for and who reads it.
- A **Table of Contents**.
- Placeholder sections with `TODO` where information is genuinely missing.
- **Assumption:** markers on anything inferred rather than decided.
- Relative cross-links to related documents.

Where a statement lives is not arbitrary:

| Kind of statement | Lives in |
|-------------------|----------|
| Why a decision was made | [adr/](../adr/README.md) |
| What something means and how it behaves | `overview/`, `system-roles/`, `tasks/`, `execution/`, `permissions/`, `communication/` |
| Exact fields, schemas, and rules | [specifications/](../specifications/README.md) |
| Implementation detail | [runtime/](../runtime/README.md) |

The distinction between the first and the second matters most. Rationale in a conceptual doc gets duplicated, drifts, and eventually contradicts the ADR.

### Style

- Prefer tables and diagrams to prose.
- State constraints as prohibitions where they are prohibitions — "the Manager must not repair work" is clearer than "the Manager focuses on oversight".
- Keep documents short. A page that is too long is usually several pages.
- Do not invent detail. If it is not decided, it is a `TODO`, not a plausible guess.

## Changing the Model

1. Check whether the change reverses an existing decision. If so, write a new ADR that supersedes it — do not edit the old one.
2. Update the conceptual doc that describes the behaviour.
3. Update the specification that defines the schema or rules.
4. Update the cross-links, including the ADR index and the [Roadmap](../roadmap/README.md).
5. Check whether any existing `TODO` is now answered, and whether any `Assumption` has become a decision.

## Code Contributions

TODO: Describe the build, test, and submission workflow once the runtime is implemented.

## Review

Reviewers should check:

- Docs and code agree.
- Every claim is either traceable to a decision, or marked as an assumption.
- New constraints are expressed as constraints, not as convention.
- Reversed decisions have a superseding ADR.

## See Also

- [Overview](overview.md)
- [ADRs](../adr/README.md)
- [Specifications](../specifications/README.md)
