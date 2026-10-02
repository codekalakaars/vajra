# developer

Creates the plan. Built and tested, **not wired in yet**: nothing starts a Developer conversation.

| File | What |
|------|------|
| `developer.ts` | The entry point: `developerConversationTurn`, the model loop that explores the project and calls `propose_plan`. Re-exports the Developer's public names |
| `prompt.ts` | The Developer's system prompt |
| `context.ts` | The first message: project tree and summary index, sized to the model's window |
| `plan.ts` | `parseProposePlanArgs`: turns the model's `propose_plan` arguments into a `DeveloperPlan` |
| `review.ts` | Whether a plan is acceptable: shape, size limit, and whether its verify commands were measured |
| `evidence.ts` | What the Developer has read and run during planning, kept across a rejected plan |

Wiring it in means calling `developerConversationTurn` and handing its `DeveloperPlan` to `manager/execute-plan.ts`, as `bench/run.ts` does with a plan from a file.
