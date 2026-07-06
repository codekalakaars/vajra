# Contributing to Vajra

## Getting Started

### Prerequisites

- **Rust toolchain** (stable): Install via [rustup](https://rustup.rs/)
- **Linux kernel 5.13+** with Landlock support (6.2+ recommended)
- **sudo access**: Required for `setcap` to grant namespace capabilities
- **Node.js** (optional): For testing with the demo app

### Build and Test

```bash
# Build debug binary and set capabilities
make build

# Run tests
cargo test

# Run linter (must pass with zero warnings)
cargo clippy --all-targets -- -D warnings

# Format code
cargo fmt
```

### Try the Demo

```bash
make build
cd examples/demo-app
../../target/debug/vajra launch
```

## Development Workflow

### Testing Changes Locally

After making code changes:

```bash
# Rebuild (required after every change)
make build

# Run tests to verify nothing broke
cargo test

# Check for linting issues
cargo clippy --all-targets -- -D warnings
```

### Verifying Capabilities

The `vajra` binary needs `CAP_SYS_ADMIN` to create namespaces. This capability
is lost every time you rebuild, which is why `make build` runs `setcap` after
compilation.

To check if capabilities are set:

```bash
getcap target/debug/vajra
# Should show: target/debug/vajra cap_sys_admin=ep
```

If missing, run `make build` again or manually:

```bash
sudo setcap cap_sys_admin+ep target/debug/vajra
```

### Common Debugging Tips

- **Kernel support**: Verify with `uname -r` (need 5.13+) and check
  `/sys/kernel/security/landlock/` exists
- **Test without sandbox**: Run your app normally first to ensure it works
  before testing under vajra
- **Check socket communication**: The supervisor socket lives in
  `$XDG_RUNTIME_DIR` (usually `/run/user/$UID/`) as `vajra-<pid>.sock`
- **Inspect allowed paths**: Use `--allow` and `--allow-rw` flags to grant
  additional access if your app needs it

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
feat(sandbox): add timeout support for subprocess runs
fix(cli): handle permission denied on Linux
docs: add Quick Start guide
```

Breaking changes use `!` before the colon: `feat!: drop Windows 10 support`

## Pull Request Process

1. Open an issue first for significant changes
2. Keep PRs focused on a single concern
3. Ensure all tests pass
4. Squash commits before merge

## Code Style

- Follow existing conventions in the codebase
- Run the formatter before committing

## License

By contributing, you agree that your contributions will be licensed under [Apache 2.0](LICENSE).
