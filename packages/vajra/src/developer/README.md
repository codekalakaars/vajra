# developer

Creates the plan, in conversation with a person.

| File | What |
|------|------|
| `conversation.ts` | `planWithDeveloper`: the loop. The Developer's questions go to a person, a proposed plan waits for their review, feedback goes back as the next message. Returns an accepted plan |
| `developer.ts` | `developerConversationTurn`: one turn, the model loop that explores the project and calls `propose_plan`. Re-exports the Developer's public names |
| `prompt.ts` | The Developer's system prompt |
| `context.ts` | The first message: project tree and summary index, sized to the model's window |
| `plan.ts` | `parseProposePlanArgs`: turns the model's `propose_plan` arguments into a `DeveloperPlan` |
| `review.ts` | Whether a plan is acceptable: shape, size limit, and whether its verify commands were measured |
| `evidence.ts` | What the Developer has read and run during planning, kept across a rejected plan |

`cli/run.ts` wires this to a terminal and hands the accepted plan to `manager/execute-plan.ts`.
