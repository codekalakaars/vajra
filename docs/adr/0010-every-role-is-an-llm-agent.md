# ADR-0010: Every Role Is an LLM Agent With Its Own Model

## Status

Accepted

## Date

2026-09-28

## Context

Three of the four roles reason. The Developer interprets a Human requirement and decomposes it into tasks; the Manager inspects completed work against success criteria and decides whether it is acceptable; a Worker decides how to make a failing test pass. None of those is a lookup. Each is judgement applied to a situation no one anticipated in advance, which is what an LLM is for.

That makes the three of them the same kind of thing: an **agent** — a role instantiated as a running process with a model behind it. Treating them as different in kind, with the Manager as a fixed traversal and only the Developer and Worker as "AI", has been an accident of implementation rather than a design position. The consequences leak: nobody can say what a Manager is, because on some paths it is a rule engine and on others a model call.

If all three are agents, the next question is immediate. One model for the whole system is the default assumption, and it is the wrong one, because the three roles want different things from a model:

| Role | What it reasons about | What that demands |
|------|----------------------|---------------------|
| Developer | Requirement ambiguity, codebase shape, task decomposition | Strong reasoning; it decides whether the work is even specified correctly |
| Manager | Whether output satisfies stated criteria | Sound judgement; it is the system's only independent check |
| Worker | A concrete edit against concrete files | Capability and speed; many run concurrently, so cost is multiplied |

A single global model forces one compromise across all three. Choosing the strongest available model for everything makes a concurrency-4 Worker fan-out expensive for a planning role that runs once. Choosing a cheap one for everything weakens the Developer on exactly the work that determines whether anything downstream can succeed.

**Scope note.** This is about **models**, not providers. [ADR-0009](0009-opencode-zen-is-the-only-provider.md) fixes OpenCode Zen as the only provider and `OPENCODE_API_KEY` as the only credential; that decision is unchanged and unaffected. Per-role configuration selects among the models the one provider already serves. A role being allowed to use a *different provider* remains undecided, and would be a separate ADR.

## Decision

**Developer, Manager and Worker are all agents. The Human is not.**

- Each of the three is an LLM-backed agent that instantiates one architectural role.
- Each agent's model is configured **independently** of the others. One model for the whole system is not the shape of the system.
- The Human holds a role but is not an agent, and has no model. The distinction is categorical, not a matter of degree: a Human decides, an agent infers.
- A model's capability grants no authority. Choosing a weaker model narrows what a role can do well; it never widens what a role is permitted to do. Every restriction in [Agent Specification](../specifications/agent-spec.md) holds for every model.
- Roles keep their existing prohibitions unchanged. Making the Manager an agent does not let it repair work ([ADR-0004](0004-manager-inspects-never-repairs.md)), and making Workers agents does not let them create tasks ([ADR-0001](0001-developer-only-task-creation.md)).

```typescript
interface Agent {
  role: Role;
  /** The single task this agent is currently executing, if Worker. */
  currentTaskId?: string;
  /** The model backing this agent. Independently configured per agent. */
  model: string;
}
```

## Consequences

**Positive**

- Each role can be matched to a model that suits what it actually does, instead of one compromise across three different jobs.
- Cost and latency become controllable per role. The expensive reasoning happens once in the Developer rather than on every task in a parallel fan-out.
- Upgrading the Developer raises plan quality without raising the cost of every task that follows it.
- The Manager stops being a special case. It is an agent like the others, which is what makes "who inspected this, and with what" a question with an answer.

**Negative**

- **A run is no longer described by one model.** Two runs of the same plan can differ because the Developer's model changed between them. Reproducibility has to be stated per role or not at all.
- Attribution gains a variable. A failure may belong to the task, the code, or the model of whichever role was reasoning. This is the same class of problem as mutation scoring making test quality a second explanation for a green suite, and it deserves the same honesty.
- **Cost is no longer predictable from a single number.** A reasoning-heavy Manager over a large plan can dominate the bill even though it runs once per submission, while a cheap Manager over a large one is invisible in the total.
- **Per-role configuration can weaken the system's one independent check.** [ADR-0004](0004-manager-inspects-never-repairs.md) holds that inspection is meaningful because the Manager neither wrote the code nor defined the criteria. That independence is about *who* inspects, not *how well* — and configuring a deliberately weak Manager model spends it. A run whose Manager model is below the Developer's deserves to be treated as unverified, and nothing currently marks it.
- The configuration surface grows from one setting to three, plus a defined answer for what an unset role model means.

**Neutral**

- The provider is unchanged. This adds model selection within one provider, not a provider abstraction. The seam ADR-0009 identified does not move.
- Being an agent is not authority. A role's prohibitions are enforced by the harness regardless of which model is behind it, and a stronger model does not earn a Worker the right to write outside its task.

## Open Questions

- **What is the fallback for a role whose model is unset** — the session default, the Developer's model, or a refusal? A silent fallback makes misconfiguration invisible; a refusal makes it loud at the worst possible moment.
- **Where does a role model live**: a CLI flag, a session setting, or a project default? Project-level would make a plan's inspection quality a property of a repository, which is a different and probably wrong kind of stickiness.
- **May the Manager's model be weaker than the Worker's?** Inspection and execution are different competences, so this is legitimate in principle — but it is also the configuration most likely to quietly hollow out ADR-0004.
- **What happens when roles have different capabilities?** A Developer on a 1M-context model and Workers on a 200k one can be handed tasks the Workers cannot even read. A per-role capability floor is implied and not yet written down.
- **Is model choice recorded anywhere durable?** State lives in `~/.vajra` per [State on Disk](../runtime/state.md); whether a session records which model each role used is undecided, and "unattributable" is the answer that costs the most later.

## See Also

- [ADR-0001 — Developer-Only Task Creation](0001-developer-only-task-creation.md)
- [ADR-0004 — The Manager Inspects and Escalates, Never Repairs](0004-manager-inspects-never-repairs.md)
- [ADR-0009 — OpenCode Zen Is the Only LLM Provider](0009-opencode-zen-is-the-only-provider.md)
- [Agent Specification](../specifications/agent-spec.md)
- [System Roles](../system-roles/README.md)
- [LLM Providers](../runtime/llm-providers.md)
