# Vajra

Vajra keeps AI CLI agents (opencode, claude, codex, ...) confined to a project
so they can work on your code without reading your secrets.

## Architecture

| Package | Description |
| --- | --- |
| `@codekalakaars/vajra-core` | Rust napi-rs addon — file/process/env/path primitives, sandbox enforcement |
| `@codekalakaars/vajra-sandbox` | Standalone TypeScript sandbox — file locks, permissions, daemon, CLI |
| `@codekalakaars/vajra-protocol` | Shared RPC types, tool definitions, push event shapes |
| `@codekalakaars/vajra-cli` | Shipping product — multi-agent task execution from the terminal |
| `@codekalakaars/vajra-agent-core` | Shared pure agent helpers (summary/tree/tools) used by the CLI and server |
| `@codekalakaars/vajra-server` | *(experimental)* WebSocket + SQLite backend, agent loop, session management |
| `@codekalakaars/vajra-web` | *(experimental)* React SPA — chat UI, session management, real-time streaming |

## Status

| Layer | State |
| --- | --- |
| File / process / env / path primitives | Implemented, tested on Linux/macOS/Windows in CI |
| Env-file parsing, sample generation, redaction | Implemented; project `.env` entries are masked out of the file index |
| Per-file permission config | Implemented |
| Sandbox enforcement (CLI `vajra run`) | Confined worker calls `applySandbox` — Linux (Landlock) and macOS (Seatbelt); **none on Windows** |
| Sandbox enforcement (server path) | Experimental worker only; not the shipping path |
| Multi-agent orchestration | Developer/master/worker roles with plan confirmation |
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

A fresh clone cannot run the CLI until the native binary is built: `*.node` is
gitignored while the generated `index.js` / `index.d.ts` loader is committed, so
`@codekalakaars/vajra-core` throws on import until `pnpm build` has produced the
addon.

```bash
pnpm install
pnpm build        # napi build --platform --release — required first
pnpm test         # Node smoke tests against the built addon
cargo test --manifest-path packages/core/Cargo.toml
cargo clippy --manifest-path packages/core/Cargo.toml --all-targets -- -D warnings
pnpm cli          # build the CLI and run it (vajra --help)
```

CI runs on ubuntu, macos and windows.

## Security model

Vajra protects against an agent accidentally or casually reading secrets. It
does not defend against one that deliberately writes exfiltration code. Network
access is unrestricted since agents need their LLM APIs.

Enforced today on the CLI path (`vajra run`):

- **Filesystem confinement** — Landlock on Linux, Seatbelt on macOS. Tools run
  in a forked worker that calls `applySandbox` before touching anything.
- **Output redaction** — `redact` replaces secret values with `[REDACTED:KEY]`.
- **Secret masking** — project `.env` files are excluded from `listFiles` and
  the summary index, so their contents are not handed to the model.

Not enforced yet:

- **Nothing on Windows.** `applySandbox` refuses rather than pretending.
- The experimental server/web path is not the shipping product; see Status above.

Confinement is process-wide and irreversible.

## License

[Apache 2.0](LICENSE)
