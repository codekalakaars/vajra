# Working in this repository

Vajra runs a plan of tasks on parallel, sandboxed Workers under a Manager. Read [docs/architecture.md](docs/architecture.md) first (5 minutes); it maps every folder.

## Where things are

| You want to change | Look in |
|--------------------|---------|
| How a plan is created from a conversation | `packages/vajra/src/developer/` |
| Scheduling, retries, CPU/RAM admission, pausing, file leases | `packages/vajra/src/manager/` |
| What a Worker sees and does: prompt, context pack, compaction, checkpoints | `packages/vajra/src/worker/` |
| The model client, the model catalog, token budget, tool dispatch | `packages/vajra/src/model/` |
| The bench runner, run parameters, metrics | `packages/vajra/src/bench/` |
| The `vajra` command (`run`, `bench`, `bench-plan`, `auth`) | `packages/vajra/src/cli/` |
| File rules, locks, change history, the confined worker process, the repo index | `packages/sandbox/src/` |
| Shared types, tool definitions, plan validation | `packages/protocol/src/` |
| Landlock, process control (Rust) | `packages/native/src/` |
| Task suites, Developer cases, run parameters, sweeps, results | `bench/` |

Each folder under `packages/vajra/src/` has a short `README.md` listing its files.

## Commands

```bash
pnpm install
pnpm build:all     # builds everything, including the Rust addon (needs a Rust toolchain)
pnpm test:all      # every package's tests, then the bench tooling tests
```

Tests import from `dist/`, so **build before testing**. To run one package: `pnpm --filter @codekalakaars/vajra test`. To run one file: `node --test packages/vajra/test/<name>.test.mjs`.

`vajra run`, `vajra bench <suite>` and `vajra bench-plan <case>` call a real model and cost money. Do not run them, or `bench/tune.mjs`, without being asked.

## Rules

- **`bench/config.json` is the only source of run parameters.** No environment variable, flag or default in code. Every key is required.
- **The replay fixtures** in `packages/vajra/test/fixtures/replay/` pin the legacy prompt. With the context switches off, they must not change.
- Linux only. The sandbox needs kernel 5.13+ (Landlock).
- Comments explain *why*, in plain sentences. Input is validated by hand; no new dependencies without a reason.
- Never commit unless asked.
