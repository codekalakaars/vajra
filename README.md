# Vajra

Vajra keeps AI CLI agents (opencode, claude, codex, ...) confined to a project
so they can work on your code without reading your secrets.

## Architecture

| Package | Description |
| --- | --- |
| `@codekalakaars/vajra-core` | Rust napi-rs addon — file/process/env/path primitives, sandbox enforcement |
| `@codekalakaars/vajra-sandbox` | Standalone TypeScript sandbox — file locks, permissions, config, CLI |
| `@codekalakaars/vajra-protocol` | Shared RPC types, tool definitions, push event shapes |
| `@codekalakaars/vajra-cli` | Shipping product — multi-agent task execution from the terminal |
| `@codekalakaars/vajra-agent-core` | Shared pure agent helpers (summary/tree/tools) used by the CLI |

## Status

| Layer | State |
| --- | --- |
| File / process / env / path primitives | Implemented, tested on Linux in CI |
| Env-file parsing, sample generation, redaction | Implemented; project `.env` entries are masked out of the file index |
| Per-file permission config | Implemented |
| Sandbox enforcement (CLI `vajra run`) | Confined worker calls `applySandbox` — Landlock |
| Multi-agent orchestration | Developer/master/worker roles with plan confirmation |
| LLM providers | **OpenCode Zen only** — `zen/*` and `go/*` model ids, one `OPENCODE_API_KEY`; a second provider is planned ([ADR](docs/adr/0009-opencode-zen-is-the-only-provider.md)) |
| API key configuration | `vajra auth login` / `status` / `logout`, `--api-key`, env, `~/.vajra/auth.json` at `0600`; a gate holds the screen until a key exists — **not tested end to end yet** ([gaps](docs/testing/gaps.md)) |
| TypeScript harness | Implemented |

## Supported platforms

**Linux only** (kernel 5.13+ for Landlock). Vajra refuses to start anywhere else
— macOS and Windows included — because the confinement it exists to provide
cannot be delivered there. There is no macOS or Windows build, CI run, or
published package.

## What the native core provides

Linux primitives, exported to Node with generated TypeScript types
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

CI runs on ubuntu.

## State on disk

Everything Vajra persists lives in `~/.vajra` (override with `VAJRA_HOME`),
created `0700`:

| Path | Holds | Mode |
| --- | --- | --- |
| `config.json` | saved defaults — `model`, `projectDir` | `0600` |
| `auth.json` | `OPENCODE_API_KEY`, in the clear | `0600` |
| `vajra.db` | sessions and message transcripts (SQLite, WAL) | `0600` |
| `index/<fingerprint>.json` | cached symbol lists and code previews | umask |
| `models.json` | model capabilities from models.dev + the gateway listing | `0600` |

`auth.json` is the only file that holds a credential, and there is no OS
keychain integration. Nothing expires automatically: stale index files and old
sessions are removed by hand, or by deleting the file.

Inside a project, Vajra reads `.vajra-sandbox.json` and `.vajra-perms.json` (it
writes neither) and creates nothing of its own — the source edits an agent makes
are the agent's work, not Vajra's state.

Full inventory, including what deliberately does not exist:
[docs/runtime/state.md](docs/runtime/state.md).

## Providers

Vajra talks to **one LLM provider, OpenCode Zen**, over its OpenAI-compatible
endpoints. `zen/*` and `go/*` are the only accepted model ids and both use one
`OPENCODE_API_KEY`; there is no provider setting and no fallback, because there
is no second provider yet. Adding one is a contained change — a base URL, a
namespace, a listing URL — with one open question about how credentials are
stored per provider.

[docs/runtime/llm-providers.md](docs/runtime/llm-providers.md)

## Security model

Vajra protects against an agent accidentally or casually reading secrets. It
does not defend against one that deliberately writes exfiltration code. Network
access is unrestricted since agents need their LLM APIs.

Enforced today on the CLI path (`vajra run`):

- **Filesystem confinement** — Landlock. Tools run
  in a forked worker that calls `applySandbox` before touching anything.
- **Output redaction** — `redact` replaces secret values with `[REDACTED:KEY]`.
- **Secret masking** — project `.env` files are excluded from `listFiles` and
  the summary index, so their contents are not handed to the model.

This is the whole model. On an unsupported platform Vajra exits at startup
rather than running unconfined, and `applySandbox` refuses rather than
pretending.

Confinement is process-wide and irreversible.

## License

[Apache 2.0](LICENSE)
