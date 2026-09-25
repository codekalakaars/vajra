# Contributing to Vajra

Vajra is an AI agent sandbox platform: `@codekalakaars/vajra-core` (Rust napi-rs
addon), `@codekalakaars/vajra-sandbox` (standalone TypeScript sandbox), a server,
web UI, and KiCad integration. Read the [README](README.md) first.

## Getting Started

### Prerequisites

- **Rust toolchain** (stable), via [rustup](https://rustup.rs/)
- **Node.js 22+** and **pnpm**

No `sudo`, `setcap`, or particular kernel version is needed.

### Build and Test

```bash
pnpm install
pnpm build                                  # builds the addon (napi build --platform --release)

pnpm test                                   # Node smoke tests, against the built addon
cargo test --manifest-path packages/core/Cargo.toml  # Rust unit tests
cargo clippy --manifest-path packages/core/Cargo.toml --all-targets -- -D warnings
cargo fmt
```

`pnpm build` regenerates `index.js` and `index.d.ts`. Both are committed — do
not hand-edit them, the next build overwrites your changes.

## Development Workflow

The two test layers catch different things, so run both:

- **`cargo test`** covers the Rust logic directly.
- **`pnpm test`** loads the built addon and exercises it from JavaScript.

After changing any `#[napi]` signature, run `pnpm build` before `pnpm test`.

### Writing bindings

- Plain data structs crossing into JS use `#[napi(object)]`, not `#[napi]`.
- Anything returning `AsyncTask` needs an explicit
  `#[napi(ts_return_type = "Promise<T>")]`.
- Operations whose cost scales with input get an `…Async` variant. Cheap
  predicates stay synchronous.
- Prefer refusing an ambiguous or destructive operation over guessing.

### Cross-platform work

- Do not hardcode `/` in tests. Build paths with `path.join` (JS) or `PathBuf`
  (Rust).
- Gate platform-specific code with `#[cfg(...)]`.
- Skip, rather than fail, tests that need privileges CI may not have.

CI runs clippy, both test suites, and a build on ubuntu, macos and windows.

## Commit Convention

This project follows **Conventional Commits**:

```
<type>(<scope>): <description>
```

| Type       | Usage                           |
|------------|----------------------------------|
| `feat`     | New feature                     |
| `fix`      | Bug fix                         |
| `chore`    | Maintenance, tooling, config    |
| `docs`     | Documentation                   |
| `refactor` | Code change, no behavior change |
| `test`     | Adding/updating tests           |
| `perf`     | Performance improvement         |
| `style`    | Formatting, no logic change     |

Breaking changes use `!` before the colon: `feat!: drop setEnv binding`

## Pull Request Process

1. Open an issue first for significant changes
2. Keep PRs focused on a single concern
3. Ensure all tests pass on every platform in the matrix
4. Squash commits before merge

## Code Style

- Follow existing conventions in the codebase
- Run the formatter before committing

## License

By contributing, you agree that your contributions will be licensed under [Apache 2.0](LICENSE).
