# bench

`vajra bench <suite>`: run a predefined plan with the arrangement in `bench/config.json`, and score it.

| File | What |
|------|------|
| `run.ts` | The command: fresh copy of the suite, run the plan through the Manager, run the acceptance tests, write the result |
| `params.ts` | `WorkerParams`: every run parameter, and `TODAYS_PARAMS` (the defaults interactive code and the replay fixtures use) |
| `config.ts` | `loadWorkerParams`: validates `bench/config.json`, names the bad key |
| `metrics.ts` | Wall time, critical path, idle, paused, context use, per-task rounds |
| `result.ts` | The shape of a result |

The suites, sweeps and tuning script are in the repository's top-level `bench/`. See `docs/bench-and-tuning.md`.
