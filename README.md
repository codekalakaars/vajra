# Vajra

Vajra keeps AI CLI agents (opencode, claude, codex, …) confined to a project
so they can work on your code without reading your secrets.

**This branch is a rewrite in progress.** Vajra is moving from a standalone
Linux-only Rust CLI to `vajra-native`, a napi-rs addon that a TypeScript
harness drives: Rust does the native work, TypeScript does the orchestration.
The previous CLI is preserved under [`legacy/`](legacy/) and still contains the
only copy of the sandbox, supervisor and permissions GUI.

## Status

| Layer | State |
| --- | --- |
| File / process / env / path primitives | Implemented, tested on Linux/macOS/Windows in CI |
| Env-file masking and redaction | Not ported yet — lives in `legacy/` |
| Sandbox enforcement (Landlock / Seatbelt) | Not ported yet — lives in `legacy/` |
| TypeScript harness | Not started (`packages/`) |

Nothing on this branch confines an agent yet. The security surface described in
[Security model](#security-model) is a property of the legacy CLI and has not
been carried over. Do not treat the current native core as a sandbox.

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

Operations whose cost scales with the data — reads, writes, tree walks and
anything that waits on a subprocess — also have `…Async` variants that run off
the event loop. Prefer those in a harness; the synchronous versions block Node
for the full duration of the call.

A few behaviours are deliberate and worth knowing:

- `listFiles` reports symlinks but never follows them, and caps depth at 8. A
  symlink pointing at one of its own ancestors would otherwise recurse forever.
- `deleteFile` refuses directories. Recursive removal is an explicit
  `deleteDir(path, true)`, so a tree is never destroyed by accident.
- `editFile` fails on an absent *or ambiguous* match rather than silently
  rewriting every occurrence. Pass `replaceAll` when that is what you mean.
- `normalizePath` resolves `.` and `..` lexically, so it works on paths that do
  not exist yet. Use `realPath` when you need symlinks resolved.
- There is no `setEnv`/`removeEnv`. `std::env::set_var` races with other
  threads and Node runs workers; assign to `process.env` instead.

## Build

Requires Rust (stable) and Node 22+ with pnpm.

```bash
pnpm install
pnpm build        # napi build --platform --release
```

This produces a platform-suffixed addon (`vajra-native.<triple>.node`) plus the
generated `index.js` loader and `index.d.ts`. Both generated files are
committed; do not hand-edit them, as the next build overwrites them.

```bash
pnpm test         # Node smoke tests against the built addon
cargo test        # Rust unit tests
cargo clippy --all-targets -- -D warnings
```

CI runs all of the above on ubuntu, macos and windows. That matrix is the only
thing that actually demonstrates cross-platform support — a green Linux run
does not.

## Security model

*Describes the legacy CLI under [`legacy/`](legacy/). Not yet true of this branch.*

Vajra protects against an agent **accidentally or casually** reading secrets:
`.env` files are masked, host env is stripped, files outside the project are
unreachable via Landlock, and app output is scrubbed of secret values. It does
*not* fully defend against an agent that deliberately writes exfiltration code
— the same limitation CI log masking has. Network access is unrestricted, since
agents need their LLM APIs.

One deliberate exception to "host env is stripped": the agent's *own* LLM
credentials (`ANTHROPIC_API_KEY`, `auth.json`, and similar — see
`legacy/src/allow.rs`) are forwarded into the sandbox, since the agent cannot
function without them. Those are the developer's own credentials, not the
project's secrets.

When this is ported, enforcement will be per-platform and reported honestly:
Landlock on Linux, Seatbelt on macOS, and **no filesystem confinement on
Windows** — where the API will say so rather than implying a guarantee it
cannot make.

## License

[Apache 2.0](LICENSE)
