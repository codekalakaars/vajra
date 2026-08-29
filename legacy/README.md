# legacy/

The previous Vajra: a standalone Linux-only Rust CLI that sandboxed an AI agent
inside a project directory.

**This code is not built and not maintained.** It is kept as the reference for
porting its functionality into `vajra-native`, the napi-rs core at the repo
root. It is excluded from the workspace, so `cargo build` and `pnpm build` do
not touch it. Please do not send changes against it.

## Why it is here rather than only in git history

Two of these files — `src/gui.rs` and `src/permissions.rs` — never existed on
`main`. They were added on `feat/file-permissions-gui`, and this branch is
based on `main`. Deleting the directory would leave that branch as their only
home.

## What is in it

| Path | What it does |
| --- | --- |
| `src/landlock.rs` | Landlock LSM rules, ABI detection, per-file permission bits |
| `src/sandbox.rs` | Namespace setup, bind mounts, private `/tmp` |
| `src/supervisor.rs` | Unix-socket supervisor: runs the app with real secrets, redacts output |
| `src/allow.rs` | Toolchain/state dir detection, agent credential passthrough |
| `src/envfile.rs` | `.env` parsing and `.sample.env` generation |
| `src/envpick.rs` | Interactive env-file picker |
| `src/permissions.rs` | Per-file permission config (`.vajra-perms.json`) |
| `src/gui.rs`, `src/gui/` | Local web GUI for editing those permissions |
| `src/config.rs` | `.vajra.toml` persistence |
| `src/main.rs`, `src/bin/vajra-run.rs` | CLI entry points |
| `examples/demo-app/` | Dependency-free Node app used to exercise the sandbox |
| `scripts/integration-test.sh` | Manual end-to-end test driver |

## Port status

| Module | Ported to |
| --- | --- |
| `src/envfile.rs` | `src/envfile.rs` |
| `src/permissions.rs` | `src/permissions.rs` (flat scan; the config format is unchanged) |
| `redact` from `src/supervisor.rs` | `src/secret.rs` |
| `src/landlock.rs` | `src/sandbox/linux.rs` (rules now keyed by absolute path) |
| everything else | not planned |

Still only here: the `.env` bind-mount masking and private `/tmp` from
`src/sandbox.rs`, which need mount namespaces, and the supervisor's socket
protocol.

`sandbox.rs` and `supervisor.rs` are process-lifecycle concerns rather than
native primitives; whether the TypeScript harness takes them over is still open.
`envpick.rs` (interactive picker) and `gui.rs` belong in the harness, not the
native core.

## Running it

If you need to observe the old behaviour, build it as its own crate:

```bash
cd legacy
make build          # debug build + setcap
```

Requires Linux (kernel 5.13+, full enforcement on 6.2+) and `sudo` for
`setcap`.
