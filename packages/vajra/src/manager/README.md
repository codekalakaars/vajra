# manager

Runs a plan. Never edits code itself.

| File | What |
|------|------|
| `execute-plan.ts` | `executePlan`: builds the queue, takes leases, starts Workers, records attempts and handoffs, returns the report |
| `master.ts` | The scheduling loop (`masterLoop`) and the failure policy (`decideFailure`): retry, skip or abort |
| `taskqueue.ts` | Task state and dependencies |
| `governor.ts` | Reads CPU and RAM; decides whether another Worker may start or one must pause. There is no Worker count |
| `pause.ts` | The gate that holds a paused Worker's model loop |
| `leases.ts` | Which files a task needs exclusively or shared; when two tasks conflict |
| `handoff.ts` | What a finished task tells its dependents |
| `registry.ts` | The agents of a run, for the event timeline |
| `report.ts` | The final report and exit code |
| `ui.ts` | The event types a run emits (`TaskEvent`, `AgentEvent`) and how tool calls are summarised |
