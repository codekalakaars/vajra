# developer

Creates the plan. Built and tested, **not wired in yet**: nothing starts a Developer conversation.

| File | What |
|------|------|
| `developer.ts` | The model loop that explores the project and calls `propose_plan`; plan parsing (`parseProposePlanArgs`) and validation; the evidence ledger |
| `tools.ts`, `tree.ts` | Re-exports of the Developer's tool specs and the project tree from `@codekalakaars/vajra-sandbox` |

Wiring it in means calling `developerConversationTurn` and handing its `DeveloperPlan` to `manager/execute-plan.ts`, as `bench/run.ts` does with a plan from a file.
