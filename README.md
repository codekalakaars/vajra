# Vajra

Vajra keeps AI CLI agents (opencode, claude, codex, …) confined to a project
so they can work on your code without reading your secrets.

**This branch is a rewrite in progress.** Vajra is moving from a standalone
Linux-only Rust CLI to `vajra-native`, a napi-rs addon that a TypeScript
harness drives: Rust does the native work, TypeScript does the orchestration.
The previous CLI is preserved under [`legacy/`](legacy/), which is still the
only copy of the supervisor, the mount-namespace setup and the permissions GUI.

## Status

| Layer | State |
| --- | --- |
| File / process / env / path primitives | Implemented, tested on Linux/macOS/Windows in CI |
| Env-file parsing, sample generation, redaction | Implemented |
| Per-file permission config | Implemented |
| Sandbox enforcement | Linux (Landlock) and macOS (Seatbelt); **none on Windows** |
| Env-file masking via bind mounts | Not ported — needs mount namespaces, `legacy/` only |
| TypeScript harness | Not started (`packages/`) |

Filesystem confinement is real on Linux and macOS: the test suite applies a
policy in a child process and asserts the kernel denies a read outside the
project, so "enforced" is observed rather than assumed.

On **Windows nothing is enforced**. `applySandbox` fails there by default
rather than returning a success that implies confinement it did not apply; a
caller that wants to continue anyway has to pass `allowUnenforced`.

Note also that `.env` masking is still unported — a sandboxed agent is confined
to the project but can read the real `.env` inside it. That masking relied on
bind mounts, which need the mount namespaces the legacy CLI set up.

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
- `redact` ignores values shorter than `minRedactableLength()` (4). A two-digit
  port is too common in ordinary output to match safely — check that bound
  rather than assuming every variable is scrubbed.
- `scanProject` returns a flat list with project-relative, `/`-separated paths,
  so a permission config written on one platform still resolves on another.
- Permissions default to read-only, and `.vajra-perms.json` keeps the legacy
  CLI's format so existing files still load.
- `applySandbox` confines **the calling process**, irreversibly, including every
  child it later spawns — the harness itself included. Call it immediately
  before handing control to the agent, never speculatively.
- Check `sandboxCapabilities()` before relying on confinement. `partial` means
  an older Landlock ABI cannot honour every restriction; `unsupported` means
  there is none at all.
- The shared system temp directory is **not** granted. The legacy CLI could
  allow `/tmp` safely because it gave the sandbox a private one via a mount
  namespace; without that, granting it would expose every other process's
  scratch files. Pass a private scratch directory in `readWritePaths` instead.
- On macOS the process's **own** temp and cache container
  (`/private/var/folders/<xx>/<yyyy>`, the parent of `TMPDIR`) is granted, because
  macOS and Node need it to function. Files sitting beside the project *inside
  that container* are therefore reachable. `applySandbox` names the granted path
  in its warnings. Put the project somewhere else — under `$HOME`, as a real
  project would be — rather than in the system temp dir.

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

Vajra protects against an agent **accidentally or casually** reading secrets. It
does *not* defend against one that deliberately writes exfiltration code — the
same limitation CI log masking has. Network access is unrestricted, since agents
need their LLM APIs. Review what the agent commits.

What this branch enforces today:

- **Filesystem confinement** — Landlock on Linux, Seatbelt on macOS. Paths
  outside the project (and outside the read-only system paths a process needs)
  are denied by the kernel. Per-file permissions from `.vajra-perms.json` are
  applied as individual rules.
- **Output redaction** — `redact` replaces secret values with
  `[REDACTED:KEY]`, for a harness streaming an app's output back to an agent.

What it does **not** enforce yet, and you should not assume:

- **Nothing on Windows.** There is no filesystem confinement available;
  `applySandbox` refuses rather than pretending.
- **`.env` files are not masked.** An agent confined to the project can still
  read the project's real `.env`. The legacy CLI masked these with read-only
  bind mounts, which need mount namespaces this layer does not set up.
- **The host environment is not stripped**, and no credential passthrough
  policy is applied — that logic is still `legacy/src/allow.rs`. Both belong to
  process launch, which the TypeScript harness will own.

Confinement is process-wide and irreversible: `applySandbox` restricts the
calling process and everything it spawns afterwards, itself included.

## License

[Apache 2.0](LICENSE)
