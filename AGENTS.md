# Working in this repository

Vajra is a CLI that confines a shell so an AI coding agent running inside it cannot act outside a policy. Read [README.md](README.md) first: it says what is built and what is not.

## Where things are

| You want to change | Look in |
|--------------------|---------|
| The `vajra` command | `packages/vajra/src/cli/` |
| File rules, the policy file, secret masking, change history, process freezing | `packages/sandbox/src/` |
| Landlock, running a command with a deadline, paths, env, redaction (Rust) | `packages/native/src/` |

## Commands

```bash
pnpm install
pnpm build:all     # builds everything, including the Rust addon (needs a Rust toolchain)
pnpm test:all      # every package's tests
```

Tests import from `dist/`, so **build before testing**. To run one package: `pnpm --filter @codekalakaars/vajra-sandbox test`. To run one file: `node --test packages/sandbox/test/<name>.test.mjs`.

## Rules

- Linux only. Confinement is the product: do not add a fallback that looks like a sandbox and is not one. The sandbox needs kernel 5.13+ (Landlock).
- A guard that cannot be enforced must say so and refuse, never degrade silently.
- Comments explain *why*, in plain sentences. Input is validated by hand; no new dependencies without a reason.
- Never commit unless asked.
