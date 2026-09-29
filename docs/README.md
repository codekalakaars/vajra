# Vajra AI Agent Harness — Documentation

## Purpose

This directory contains the complete documentation for the Vajra AI Agent Harness, a multi-agent software engineering system. The documentation is organized by concern and serves contributors, future maintainers, open-source users, and enterprise customers.

## Conventions

- Architecture decisions live in `overview/`, `adr/`, and `specifications/`.
- Implementation details (file paths, APIs, config keys) live in `runtime/`.
- Every document includes a **Purpose** section and a **Table of Contents**.
- Missing information is marked with `TODO`.
- Inferred content is marked with **Assumption:** — these are proposals, not settled decisions.
- Settled decisions are captured as ADRs in `adr/`.
- Cross-references use relative paths (e.g., `[Worker Role](system-roles/worker.md)`).

## Architecture Roles

| Role | Description | Agent | Model |
|------|-------------|:-----:|:-----:|
| Human | The end user. Talks only to the Developer and approves every plan and final result. | No | — |
| Developer | The only entity allowed to create tasks. Acts on the Human's conversation and approval. | Yes | Independent |
| Manager | Schedules and supervises Workers, runs the verification ladder, reviews results, and kills each Worker at its verdict. | Yes | Independent |
| Worker | Executes one task at a time. Sees its peers through the Manager and may request more access. | Yes | Independent |

Developer, Manager and Worker are all **LLM-backed agents**, and each is configured with **its own model** — the three roles want different things from a model, and a run is not described by a single model id. The Human holds a role but is not an agent. A model grants no authority: it changes how well a role performs, never what it may do. See [Every Role Is an LLM Agent](specifications/agent-spec.md#every-role-is-an-llm-agent) and [ADR-0010](adr/0010-every-role-is-an-llm-agent.md).

The Manager has a mechanical part (deterministic code: scheduling, permissions, file ownership, the verification ladder) and an LLM part (the Manager agent: verdicts and access requests). See [ADR-0012](adr/0012-verification-ladder-replaces-phase-one.md), [ADR-0013](adr/0013-manager-verifies-reviews-and-retires-workers.md) and [ADR-0014](adr/0014-peer-aware-workers-and-access-requests.md).

## Documentation Map

| Concern | Entry Point | Description |
|---------|-------------|-------------|
| Overview | [overview/overview.md](overview/overview.md) | High-level architecture and design principles |
| System Roles | [system-roles/README.md](system-roles/README.md) | Agent roles, responsibilities, and interactions |
| Tasks | [tasks/README.md](tasks/README.md) | Task lifecycle, creation, and management |
| Execution | [execution/README.md](execution/README.md) | How tasks are executed and coordinated |
| Permissions | [permissions/README.md](permissions/README.md) | Access control and permission model |
| Communication | [communication/README.md](communication/README.md) | Inter-agent messaging and protocols |
| Testing | [testing/README.md](testing/README.md) | Mechanical verification of micro-tasks, APIs, and any language |
| ↳ Surfaces | [testing/surfaces.md](testing/surfaces.md) | Every development surface, and how it is tested |
| ↳ Gaps | [testing/gaps.md](testing/gaps.md) | What the testing system cannot test, and why |
| Runtime | [runtime/README.md](runtime/README.md) | System runtime, deployment, and operations |
| ↳ State | [runtime/state.md](runtime/state.md) | Everything the shipped CLI stores on disk, and what holds a secret |
| ↳ Providers | [runtime/llm-providers.md](runtime/llm-providers.md) | The one LLM provider, its credential, and extending it |
| Specifications | [specifications/README.md](specifications/README.md) | Formal specifications and RFCs |
| ADRs | [adr/README.md](adr/README.md) | Architecture Decision Records — why, not just what |
| Roadmap | [roadmap/README.md](roadmap/README.md) | Future direction and planned features |

## Quick Links

- [Glossary](overview/glossary.md)
- [Contributing Guide](overview/contributing.md)
- [Security Model](permissions/security-model.md)
- [Agent Protocol](communication/protocol.md)
- [State on Disk](runtime/state.md) — what lives in `~/.vajra`
- [LLM Providers](runtime/llm-providers.md) — OpenCode Zen only, for now
- [Coverage Gaps](testing/gaps.md) — the API key path is not tested end to end
