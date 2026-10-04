# bench

`vajra bench <suite>`: run a predefined plan with the arrangement in `bench/config.json`, and score it.

| File | What |
|------|------|
| `run.ts` | The command and `runBench`: fresh copy of the suite, run the plan through the Manager, write the result |
| `suite.ts` | Reading a suite from disk: its plan, acceptance command and fixture; the setup error |
| `plan-run.ts` | `vajra bench-plan <case>`: the Developer plans one case from `bench/developer/` on a copy of its fixture, no Workers, and the plan is checked |
| `plan-checks.ts` | `checkPlan`: size, scope, coverage, grounding, verify, dependencies and questions, judged on the plan alone; `parseExpectation` reads `expect.json` |
| `checks.ts` | The checks made before anything runs: verify commands fail on the fixture, every pack fits |
| `bench-ui.ts` | The UI a bench run gives the Manager: it feeds the recorder and prints nothing unless asked |
| `acceptance.ts` | Running the suite's acceptance tests after the run |
| `params.ts` | `WorkerParams`: every run parameter, and `TODAYS_PARAMS` (the defaults interactive code and the replay fixtures use) |
| `config.ts` | `loadWorkerParams`: validates `bench/config.json`, names the bad key |
| `metrics.ts` | Wall time, critical path, idle, paused, context use, per-task rounds |
| `result.ts` | The shape of a result |

The suites, sweeps and tuning script are in the repository's top-level `bench/`. See `docs/bench-and-tuning.md`.
