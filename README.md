# Vajra

Vajra keeps AI CLI agents (opencode, claude, codex, ...) confined to a project
so they can work on your code without reading your secrets.

## Architecture

| Package | Description |
| --- | --- |
| `@codekalakaars/vajra-core` | Rust napi-rs addon — file/process/env/path primitives, sandbox enforcement |
| `@codekalakaars/vajra-sandbox` | Standalone TypeScript sandbox — file locks, permissions, daemon, CLI |
| `@codekalakaars/vajra-protocol` | Shared RPC types, tool definitions, push event shapes |
| `@codekalakaars/vajra-server` | WebSocket + SQLite backend, agent loop, session management |
| `@codekalakaars/vajra-web` | React SPA — chat UI, session management, real-time streaming |

## Status

| Layer | State |
| --- | --- |
| File / process / env / path primitives | Implemented, tested on Linux/macOS/Windows in CI |
| Env-file parsing, sample generation, redaction | Implemented |
| Per-file permission config | Implemented |
| Sandbox enforcement | Linux (Landlock) and macOS (Seatbelt); **none on Windows** |
| Multi-agent orchestration | Manager/master/worker roles with plan confirmation |
| TypeScript harness | Implemented |

## What the native core provides

Cross-platform primitives, exported to Node with generated TypeScript types
(see [`index.d.ts`](index.d.ts)):

- **file** — `readFile`, `writeFile`, `editFile`, `deleteFile`, `deleteDir`,
  `createDir`, `listFiles`, `copyFile`, `renameFile`, plus existence and size
  predicates
- **process** — `runCommand` (no shell), `runShell`, `which`
- **env** — `getEnv`, `envExists`, `getAllEnv`, `getEnvFiltered`, `currentDir`,
  `homeDir`, `tempDir`
- **path** — `resolvePath`, `normalizePath`, `realPath`, `joinPaths`,
  `dirname`, `basename`, `extension`, `ensureExt`
- **env files** — `parseEnv`, `loadEnvFile`, `renderSampleEnv`,
  `ensureSampleEnv`
- **secrets** — `redact`, `minRedactableLength`
- **permissions** — `defaultPermissions`, `loadPermissions`, `savePermissions`,
  `permissionsFor`, `scanProject`
- **sandbox** — `sandboxCapabilities`, `applySandbox`

Operations whose cost scales with the data also have `...Async` variants that
run off the event loop.

Key behaviors:

- `listFiles` reports symlinks but never follows them, caps depth at 8.
- `deleteFile` refuses directories. Use `deleteDir(path, true)` for recursive.
- `editFile` fails on absent or ambiguous match. Pass `replaceAll` when needed.
- `copyFile` and `renameFile` refuse to replace existing destinations unless
  `overwrite` is passed.
- There is no `setEnv`/`removeEnv`. Assign to `process.env` instead.
- `redact` ignores values shorter than 4 characters.
- `applySandbox` confines the calling process irreversibly.

## Build

Requires Rust (stable) and Node 22+ with pnpm.

```bash
pnpm install
pnpm build        # napi build --platform --release
pnpm test         # Node smoke tests against the built addon
cargo test --manifest-path packages/core/Cargo.toml
cargo clippy --manifest-path packages/core/Cargo.toml --all-targets -- -D warnings
```

CI runs on ubuntu, macos and windows.

## Security model

Vajra protects against an agent accidentally or casually reading secrets. It
does not defend against one that deliberately writes exfiltration code. Network
access is unrestricted since agents need their LLM APIs.

Enforced today:

- **Filesystem confinement** — Landlock on Linux, Seatbelt on macOS.
- **Output redaction** — `redact` replaces secret values with `[REDACTED:KEY]`.

Not enforced yet:

- **Nothing on Windows.** `applySandbox` refuses rather than pretending.
- **`.env` files are not masked.** An agent can still read the project's `.env`.

Confinement is process-wide and irreversible.

## License

[Apache 2.0](LICENSE)
