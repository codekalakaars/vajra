# Contributing to Vajra

## Getting Started

- Prerequisites (TBD once stack is chosen)
- `git clone`, install deps, run dev server

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
