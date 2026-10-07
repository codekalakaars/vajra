# Vajra

A CLI that confines a shell, so an AI coding agent running inside it cannot go haywire: read your keys, write outside the project, or delete what it was never meant to touch.

Vajra is being rebuilt from a multi-agent harness down to this one job. What is here is the confinement primitive and the policy around it. **The guarded shell itself is not built yet.**

## What exists

| Piece | Status |
|-------|--------|
| Landlock confinement of file access (read, write, execute, delete, per path), applied to a process and inherited by everything it starts | Built, tested (`packages/native`) |
| `vajra doctor`: can this machine enforce it? | Built, tested |
| File policy: glob rules compiled to the permissions the addon enforces, stored in `.vajra-sandbox.json` | Built, tested (`packages/sandbox`) |
| Secret masking: `.env` files and variants are withheld, and secret values can be redacted from text | Built, tested |
| Change history: the original of each file before it is modified, for rollback | Built, tested, not wired to anything yet |
| Freeze and thaw a whole process tree | Built, tested |
| **`vajra` starting a shell or an agent under that policy** | **Not built** |
| Network control | Not built. Landlock's network rules are not used |
| Command allow and deny lists, an audit log of what the agent did | Not built |

Platform: **Linux only**, kernel 5.13+ (Landlock). No `sudo` is needed.

## Try it

```bash
pnpm install
pnpm build:all
node packages/vajra/dist/cli/index.js doctor
```

`doctor` reports the kernel, the confinement mechanism and Landlock's ABI version, and exits 0 only if file access can really be confined.

## Layout

| Folder | What |
|--------|------|
| `packages/native` | Rust (napi) addon: Landlock, running a command with a deadline, path and env handling, secret redaction |
| `packages/sandbox` | TypeScript: the policy (rules, config file), the platform check, change history, process-tree freezing |
| `packages/vajra` | The `vajra` command |

Working rules are in [AGENTS.md](AGENTS.md), how to build and contribute in [CONTRIBUTING.md](CONTRIBUTING.md), and the security policy in [SECURITY.md](SECURITY.md).

## History

The previous design (a Developer that plans, a Manager that schedules, parallel Workers) is on the branch `feat/cli-agent-v1-config`.
