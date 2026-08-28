# Contributing to Vajra

Vajra is mid-rewrite: the project is moving from a standalone Linux-only Rust
CLI to `vajra-native`, a napi-rs addon driven by a TypeScript harness. Read the
[README](README.md) first — in particular which layers exist today and which
are still only in [`legacy/`](legacy/).

Changes to the old CLI under `legacy/` are not being accepted; it is kept as a
reference for the port, not as a maintained code path.

## Getting Started

### Prerequisites

- **Rust toolchain** (stable), via [rustup](https://rustup.rs/)
- **Node.js 22+** and **pnpm**

No `sudo`, `setcap`, or particular kernel version is needed. Those were
requirements of the legacy sandbox; the native core has none.

### Build and Test

```bash
pnpm install
pnpm build                                  # builds the addon (napi build --platform --release)

pnpm test                                   # Node smoke tests, against the built addon
cargo test                                  # Rust unit tests
cargo clippy --all-targets -- -D warnings   # must pass with zero warnings
cargo fmt
```

`pnpm build` regenerates `index.js` and `index.d.ts`. Both are committed — do
not hand-edit them, the next build overwrites your changes. If you add or
change a binding, rebuild and commit the regenerated files with it.

## Development Workflow

The two test layers catch different things, so run both:

- **`cargo test`** covers the Rust logic directly. It does not build the Node
  bindings, so it cannot see anything about the JavaScript boundary.
- **`pnpm test`** loads the built addon and exercises it from JavaScript. This
  is what catches a struct exported as a class instead of a plain object, a
  loader that cannot find the platform binary, or an async binding that
  silently blocks the event loop.

After changing any `#[napi]` signature, run `pnpm build` before `pnpm test` —
otherwise you are testing the previously built addon.

### Writing bindings

A few conventions the existing modules follow:

- Plain data structs crossing into JS use `#[napi(object)]`, not `#[napi]`.
  The latter produces a JS *class*, which is almost never what a caller wants.
- Anything returning `AsyncTask` needs an explicit
  `#[napi(ts_return_type = "Promise<T>")]`, or the generated typings degrade to
  `Promise<unknown>`.
- Operations whose cost scales with input — file reads and writes, tree walks,
  anything awaiting a subprocess — get an `…Async` variant. Cheap predicates
  stay synchronous.
- Prefer refusing an ambiguous or destructive operation over guessing. See
  `editFile` and `deleteFile` in `src/file.rs` for the shape of that.

### Cross-platform work

This is the core requirement of the native layer: it must work on Linux, macOS
and Windows. A passing local build proves one of the three.

- Do not hardcode `/` in tests. Build paths with `path.join` (JS) or `PathBuf`
  (Rust) so assertions hold where the separator is `\`.
- Remember that `echo`, `exit` and friends are shell builtins on Windows, not
  programs — `runCommand` cannot invoke them directly.
- Gate genuinely platform-specific code with `#[cfg(...)]` and make sure every
  target still compiles.
- Skip, rather than fail, tests that need privileges CI may not have (creating
  a symlink on Windows, for example).

CI runs clippy, both test suites, and a build on ubuntu, macos and windows.
That matrix is the actual gate.

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

Examples:

```
feat(file): add async directory walk
fix(process): take only the first PATH match on Windows
docs: document the napi(object) convention
```

Breaking changes use `!` before the colon: `feat!: drop setEnv binding`

## Pull Request Process

1. Open an issue first for significant changes
2. Keep PRs focused on a single concern
3. Ensure all tests pass on every platform in the matrix
4. Squash commits before merge

## Code Style

- Follow existing conventions in the codebase
- Run the formatter before committing

### Pre-commit Hooks

This project uses [pre-commit](https://pre-commit.com/) to run formatting,
linting, and the Rust tests before each commit.

```bash
pipx install pre-commit    # or: pip install pre-commit
pre-commit install
```

The hooks cover `cargo fmt`, `cargo clippy`, and `cargo test`. They do not run
`pnpm test`, since that needs a built addon — run it yourself before pushing.

```bash
pre-commit run --all-files
git commit --no-verify      # skip hooks (not recommended)
```

## License

By contributing, you agree that your contributions will be licensed under [Apache 2.0](LICENSE).
