# Vajra

A CLI that confines a shell, so an AI coding agent running inside it cannot go haywire: read your keys, write outside the project, or delete what it was never meant to touch.

Working today: `vajra guard`, which runs a command or your shell confined to a project, and `vajra doctor`, which says whether this machine can enforce it. Everything else in the repository is either a building block or a leftover, listed below.

## Use it

```bash
pnpm install && pnpm build:all

# open a confined shell on the current project, then start an agent from it
node packages/vajra/dist/cli/index.js guard                 # then: claude, opencode or codex

# or confine one command
node packages/vajra/dist/cli/index.js guard -- make test

# see what would be allowed, without confining anything
node packages/vajra/dist/cli/index.js guard --dry-run

# can this machine enforce it?
node packages/vajra/dist/cli/index.js doctor
```

Inside `vajra guard`, what the command can read, write and delete in the project is set by a `.vajra.json` file, described below. Without one the project is read-only. Outside the project, only these are allowed:

- the system programs and libraries (`/usr`, `/bin`, `/lib`, `/etc` read-only, `/opt`);
- the directories on `PATH`, plus the install directory of the command itself, so it can start;
- a private temporary directory for this run (`TMPDIR` points at it), removed when it ends;
- your git config, read-only;
- whatever you add with `--allow-read` and `--allow-write`.

Everything else is denied, including your home directory (`~/.ssh`, `~/.aws`, other projects) and the shared `/tmp`. The confinement is applied by the kernel (Landlock) to the command and everything it starts, and the command cannot lift it. If the machine cannot enforce it, `vajra guard` refuses to run.

### The project policy: `.vajra.json`

Put this file at the project root to say what the command may read, write and delete in each file and folder. It starts from read-only, and a path that is not named inherits from the folder around it:

```json
{
  "version": 1,
  "default": { "read": true, "write": false, "delete": false },
  "paths": {
    "src/":        { "write": true },
    "migrations/": { "write": true, "delete": true },
    "secrets/":    { "read": false },
    "README.md":   { "write": true }
  }
}
```

You can also set rules from the command line, for one run: `--write <path>`, `--delete <path>` and `--deny-read <path>` (repeatable; a folder ends in `/`). When the rules are not in a file, the guard prints the exact `.vajra.json` that would keep them, so you can save it:

```bash
vajra guard --write src/ --write README.md --deny-read secrets/
```

Without a file the project is read-only, and the guard says so and prints the file to start from.

The command cannot write or delete the policy file itself. Some policies cannot be enforced exactly, because the kernel only adds rights below a folder. The guard refuses to start for those and says why. The main ones: no `write` or `delete` at the root (so no new files directly in the project root), no `delete` on a single file, and no `"hidden": true` (use `"read": false`; the name still shows). The full format, every refusal and the reasons are in [docs/project-policy.md](docs/project-policy.md). `vajra guard --dry-run` prints the rights it will use.

### Coding agents

`vajra guard` with no command opens your shell, confined, and you start `claude`, `opencode` or `codex` from it. Each agent gets exactly the directories it keeps its login, settings and history in, and nothing beside them (never `~/.local`, `~/.config` or the home directory). The guard prints what it granted.

Those grants are made when the shell starts, and a process cannot be given more rights later, so the shell grants every agent at once. **Inside one shell, one agent can read another agent's login.** To keep one agent out of reach, start the shell with it: `vajra guard --agent claude` gives claude's directories and no others. `vajra guard -- claude` confines claude alone, and `--agent none` turns the profiles off.

A shell is also where a project gets read-only by default: without a `.vajra.json`, the agent can read the project but not edit it (see the policy above).

| Agent | Writable | Notes |
|-------|----------|-------|
| `claude` | `~/.claude`, `~/.claude.json`, `~/.cache/claude-cli-nodejs`; follows `CLAUDE_CONFIG_DIR` | Tested with a real `claude` in an isolated home. Its install directory stays read-only, so it cannot rewrite itself. It wants a lock file and a temp file for `~/.claude.json` in your home directory, which stays closed, so it updates the file in place without the lock: run one session at a time. |
| `opencode` | data, state and cache under `~/.local/share`, `~/.local/state`, `~/.cache`; follows `XDG_*` | Tested with the real `opencode` and its real sessions. Its config directory is **read-only**, so it cannot edit its own settings or add plugins. |
| `codex` | `~/.codex`; follows `CODEX_HOME` | **Untested**: Codex was not installed where this was written, so the paths come from its documentation. It applies a sandbox of its own, which stacks inside this one. |

Only directories that already exist are granted, so log in or run the agent once, unguarded, before guarding it. The agent's install directory is granted read and run, so it starts from inside the shell. A program with no profile needs `--allow-write` for its own state. If something fails with "Permission denied", that is the guard working; add the path you trust.

## What it does not do

- **The network is not restricted.** A confined agent can still send the project, or anything it can read, over the network. This is the biggest gap.
- **Names inside the project are visible even where `read: false` applies.** A file's name and size show in a listing and `stat` still finds it, though its content does not. Only the content is protected. Keep secrets outside the project, where they are not even listed.
- **The environment is passed through unchanged**, including any tokens exported in your shell.
- **`.git`, `node_modules` and `target` are read and run only.** The project policy does not reach inside them, so `npm install` and similar cannot write there under the guard. Change history for rollback exists in `packages/sandbox` but is not connected.
- **No audit log** of what the command did.

Platform: **Linux only**, kernel 5.13+ (Landlock). No `sudo` is needed.

## What else exists

| Piece | Status |
|-------|--------|
| `vajra guard`: run a command or shell confined to a project | Built, tested against the real kernel, tried with `claude`, `git`, `node` and `python3` |
| `vajra doctor`: can this machine enforce it? | Built, tested |
| Landlock confinement in the native addon | Built, tested |
| Glob rules and `.vajra-sandbox.json` in `packages/sandbox` | Built, tested, a library API. **`guard` does not read it**; it reads `.vajra.json` |
| Change history for rollback | Built, tested, not connected |
| Freeze and thaw a process tree | Built, tested, not connected |

## Layout

| Folder | What |
|--------|------|
| `packages/native` | Rust (napi) addon: Landlock, running a command with a deadline, path and env handling, secret redaction |
| `packages/sandbox` | TypeScript: the policy (rules, config file), the platform check, change history, process-tree freezing |
| `packages/vajra` | The `vajra` command: `guard` (`src/guard/` builds the policy and launches the command) and `doctor` |

Working rules are in [AGENTS.md](AGENTS.md), how to build and contribute in [CONTRIBUTING.md](CONTRIBUTING.md), the security policy in [SECURITY.md](SECURITY.md), and design decisions and reference in [docs/](docs/README.md).

## History

The previous design (a Developer that plans, a Manager that schedules, parallel Workers) was removed in commit `5916ddd`. It is in the history before that commit, for example at `9f3be45`.
