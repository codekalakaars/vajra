# Contributing to Vajra

Read [AGENTS.md](AGENTS.md) for the map of the code and [README.md](README.md) for what is built.

## Prerequisites

- Node.js 22+ and pnpm
- A stable Rust toolchain ([rustup](https://rustup.rs/)): the sandbox is a Rust addon
- Linux, kernel 5.13+ (Landlock). No `sudo` or `setcap` is needed.

## Build and test

```bash
pnpm install
pnpm build:all          # the Rust addon and every TypeScript package
pnpm test:all           # every package

pnpm test:rust          # cargo test for the addon
pnpm lint               # cargo clippy, warnings are errors
```

Tests import from `dist/`: build first. `pnpm build:all` regenerates `packages/native/index.js` and `index.d.ts`; both are committed, do not edit them by hand.

## Pull requests

- One concern per pull request.
- `pnpm build:all && pnpm test:all` must pass.
- Record a significant decision in `docs/`, with why it was made.
