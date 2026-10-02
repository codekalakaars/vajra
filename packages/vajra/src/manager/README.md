# manager

Runs a plan. Never edits code itself.

| File | What |
|------|------|
| `execute-plan.ts` | `executePlan`: wires a run together and returns the report |
| `run-task.ts` | One attempt at one task: leases, permissions, the Worker, rollback, cleanup |
| `attempts.ts` | Attempt records and handoffs kept for the run |
| `command-locks.ts` | Locks around commands that cannot run twice at once (`npm`, `git`, `cargo`) |
| `master.ts` | The scheduling loop (`masterLoop`); also re-exports the three files below |
| `failure-policy.ts` | `decideFailure` (retry, skip or abort), rollback commands, which tasks a failure blocks |
| `ordering.ts` | Which ready task gets the next free slot: plan order, critical path, most dependents; task priorities |
| `master-llm.ts` | The optional loop that asks the model what to do about a failure |
| `taskqueue.ts` | Task state and dependencies |
| `governor.ts` | Reads CPU and RAM; decides whether another Worker may start or one must pause. There is no Worker count. Also `resolveMaxWorkers` |
| `pause.ts` | The gate that holds a paused Worker's model loop |
| `leases.ts` | Which files a task needs exclusively or shared; when two tasks conflict; taking them in a deadlock-free order |
| `handoff.ts` | What a finished task tells its dependents |
| `registry.ts` | The agents of a run, for the event timeline |
| `report.ts` | The final report and exit code |
| `ui.ts` | The event types a run emits (`TaskEvent`, `AgentEvent`) and how tool calls are summarised |
