# Vajra

Vajra runs a plan of tasks on parallel, sandboxed Workers, under a Manager. Each Worker is one model loop that can only touch the files its task names, enforced by the kernel (Landlock), not by the prompt.

```
Developer ──plan──▶ Manager ──task──▶ Worker ──▶ confined process
```

## Status

| Part | State |
|------|-------|
| Manager: scheduling by CPU and RAM, pausing, retries, file leases | Built, tested |
| Worker: context pack, output cap, elision, checkpoints | Built, tested. The pack is on in `bench/config.json` |
| Sandbox: Landlock confinement, file rules, locks, rollback | Built, tested |
| `vajra bench <suite>`: run a predefined plan and score it | Built. Four suites in `bench/suites/` |
| Developer: creates the plan from a conversation | Built and tested, **not wired in yet** |

Provider: OpenCode Zen only (`zen/*` and `go/*` model ids, one `OPENCODE_API_KEY`). Platform: **Linux only**, kernel 5.13+.

## Quick start

```bash
pnpm install          # needs Node 22+, pnpm and a stable Rust toolchain
pnpm build:all
pnpm test:all

node packages/vajra/dist/cli/index.js auth login <key>
node packages/vajra/dist/cli/index.js bench bench/suites/wide
```

`bench` calls a real model and costs money.

## Where to read next

- [docs/architecture.md](docs/architecture.md): how it fits together
- [docs/bench-and-tuning.md](docs/bench-and-tuning.md): the parameters and the tuning method
- [AGENTS.md](AGENTS.md): a map of the code and the rules for working in it

Apache-2.0. See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
