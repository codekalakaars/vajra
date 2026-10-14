# Vajra

A CLI that confines a shell, so an AI coding agent running inside it cannot go haywire: read your keys, write outside the project, or delete what it was never meant to touch.

Vajra is a protected interactive shell with a live, policy-filtered project view. `vajra` starts it in the current directory and opens the local settings page in the host browser.

## What exists

| Piece | Status |
|-------|--------|
| Landlock confinement of file access (read, write, execute, delete, per path), applied to a process and inherited by everything it starts | Built, tested (`packages/native`) |
| `vajra doctor`: can this machine enforce it? | Built, tested |
| File policy: glob rules compiled to the permissions the addon enforces, stored in `.vajra-sandbox.json` | Built, tested (`packages/sandbox`) |
| Live virtual filesystem: Linux FUSE mount filters project listings, reads, writes, and deletes using the current policy | Built in `packages/native`; used by the protected shell |
| Secret masking: `.env` files and variants are withheld, and secret values can be redacted from text | Built, tested |
| Change history: the original of each file before it is modified, for rollback | Built, tested, not wired to anything yet |
| Freeze and thaw a whole process tree | Built, tested |
| `vajra` protected shell | Built: Landlock, rootless user/mount/network/PID namespaces, and a private root that exposes the project only through FUSE |
| Network access from the protected shell | Enabled for coding tools; settings API requires a browser-held session token |
| Command allow and deny lists, an audit log of what the agent did | Not built |

Platform: **Linux only**, kernel 5.13+ (Landlock), with FUSE (`/dev/fuse`, `fusermount3`), the util-linux `unshare` command, and unprivileged user namespaces enabled. No `sudo` is needed. Vajra refuses to start if it cannot establish these boundaries.

## Try it

```bash
pnpm install
pnpm build:all
node packages/vajra/dist/cli/index.js doctor
node packages/vajra/dist/cli/index.js
```

`doctor` reports the kernel, the confinement mechanism and Landlock's ABI version, and exits 0 only if file access can really be confined.

The shell starts with a deny-all project policy if `.vajra-sandbox.json` is
missing. Vajra starts the settings page on the host and opens it in the browser;
select allowed paths and permissions, and save; the next filesystem operation sees
the change. If no desktop browser is available, Vajra prints the settings URL.
Folder rules apply to their contents. The shell has network access for coding
tools. The settings page binds to host loopback, and its API requires a session
token delivered to the browser in a URL fragment, which is not sent in HTTP
requests. The shell cannot access the backing project directory directly.
System runtime files needed to run shell commands (such as `/usr`, `/bin`, and
read-only `/etc`) are also present in the private shell root; the VFS policy
controls project files. Data already read into a running command cannot be
recalled when access is revoked.

## Layout

| Folder | What |
|--------|------|
| `packages/native` | Rust (napi) addon: Landlock, running a command with a deadline, path and env handling, secret redaction |
| `packages/sandbox` | TypeScript: the policy (rules, config file), the platform check, change history, process-tree freezing |
| `packages/vajra` | The `vajra` command |

Working rules are in [AGENTS.md](AGENTS.md), how to build and contribute in [CONTRIBUTING.md](CONTRIBUTING.md), and the security policy in [SECURITY.md](SECURITY.md).

## History

The previous design (a Developer that plans, a Manager that schedules, parallel Workers) is on the branch `feat/cli-agent-v1-config`.
