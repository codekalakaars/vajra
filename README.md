# Vajra

A CLI that confines a shell, so an AI coding agent running inside it cannot go haywire: read your keys, write outside the project, or delete what it was never meant to touch.

Working today: `vajra`, which opens a shell confined to the current project, and `vajra doctor`, which says whether this machine can enforce it. Everything else in the repository is either a building block or a leftover, listed below.

## Use it

```bash
pnpm install:global        # builds, then installs the `vajra` command to ~/.local/bin (no root)

# in any project: open a confined shell, then start an agent from it
cd ~/my-project && vajra   # then: claude, opencode, codex or pi

# can this machine enforce it?
vajra doctor
```

`pnpm install:global` (`scripts/install-global.sh`) installs a launcher that runs this checkout's build, so `pnpm build:all` updates it. `--prefix DIR` installs elsewhere, and `pnpm uninstall:global` removes it. It will not overwrite a `vajra` it did not create. It needs Node 22+, pnpm and a Rust toolchain.

Inside `vajra`, what the command can read, write and delete in the project is set by a `.vajra.json` file, described below. Without one the project is read-only. Outside the project, only these are allowed:

- the system programs and libraries (`/usr`, `/bin`, `/lib`, `/etc` read-only, `/opt`);
- the directories on `PATH`, plus the install directory of the command itself, so it can start;
- a private temporary directory for this run (`TMPDIR` points at it), removed when it ends;
- your git config, read-only;
- whatever you add with `--allow-read` and `--allow-write`.

Everything else is denied, including your home directory (`~/.ssh`, `~/.aws`, other projects) and the shared `/tmp`.

Three layers apply, and the shell and everything it starts cannot lift any of them:

| Layer | What it does |
|-------|--------------|
| **bubblewrap** | Builds the view. The machine is read-only, the shell gets a private `/tmp`, and a path with `read: false` does not exist in the view, so its name is not in a listing either. Paths with `write` or `delete` are mounted read-write. |
| **Landlock** | Inside the view, decides what may be read, written, created and removed, and denies everything outside the project and the paths above. |
| **seccomp** | Closes the calls that would get around the other two: `ptrace`, `io_uring_setup`, `mount`, `unshare` and `setns`, new namespaces through `clone`, opening a file by handle, loading kernel code, and typing into your terminal (`TIOCSTI`). |

If the machine cannot enforce any of them, `vajra` refuses to run.

### Changing the rules while you work

None of the three layers can be loosened or tightened in a running shell, so a change means a restart, and `vajra` makes that one click. When it starts it opens a **control page** in your browser (`--no-browser` prints the address instead). The page lists every file and folder with its read, write and delete rights and where each comes from (a rule, the folder above, or the default). Ticking a box writes the rule to `.vajra.json` after checking that the shell could start from the result; a change that cannot be enforced is refused with the reason and the file is left as it was.

A change does not touch the running shell. The page then offers **Apply and restart shell**: `vajra` asks the agent that is running in the terminal to finish (so it saves its session), stops the shell, starts a new one from the new rules, and starts the agent again with its own continue option:

| Agent | Started again with |
|-------|--------------------|
| `claude` | `claude --continue` |
| `opencode` | `opencode --continue` |
| `codex` | `codex resume --last` |
| `pi` | `pi --continue` |

Only the agent's name and that option carry over, not the flags it was first started with. Anything else that was running in the shell is stopped.

The page listens on `127.0.0.1` only. Every request needs a random token that only your browser is given, in the address it was opened with, and requests with another `Host` or `Origin` are refused. The shell shares your network, so it can reach the port but not the token, and so cannot change its own rules.

### Setting up

You need Linux with kernel 5.13+ (Landlock), `bubblewrap` (`apt install bubblewrap`), and a way for it to make a user namespace. `vajra doctor` shows each of these, and **`vajra doctor --fix` walks through the repairs**: it shows the exact commands for each problem, asks before running them (some use `sudo`), and checks again afterwards. It never changes the machine without a yes.

**Ubuntu 24.04 and later block that by default** (`kernel.apparmor_restrict_unprivileged_userns=1`), and `bwrap` then fails with `setting up uid map: Permission denied`. The narrow fix is an AppArmor profile that allows only `bwrap`, which needs `sudo` once; `vajra doctor --fix` does this for you. To do it by hand, save this as `/etc/apparmor.d/vajra-bwrap`:

```
abi <abi/4.0>,
include <tunables/global>
/usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

then load it with `sudo apparmor_parser -r /etc/apparmor.d/vajra-bwrap`.

Allowing user namespaces for every program (`sysctl kernel.apparmor_restrict_unprivileged_userns=0`) also works but is broader than Vajra needs.

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
    "README.md":   { "write": true },
    "docs/":       { "create": true }
  }
}
```

You can also set rules from the command line, for one run: `--write <path>`, `--delete <path>` and `--deny-read <path>` (repeatable; a folder ends in `/`). When the rules are not in a file, the guard prints the exact `.vajra.json` that would keep them, so you can save it:

```bash
(The one-off `--write`, `--deny-read` and `--dry-run` options were removed with the `guard` command.)
```

Without a file the project is read-only, and the guard says so and prints the file to start from.

The command cannot write or delete the policy file itself. Some policies cannot be enforced exactly, because the kernel only adds rights below a folder. The guard refuses to start for those and says why. The main ones: no `write` or `delete` at the root (use `"default": { "create": true }` to let the shell make new files in the root without changing the ones there, or `"create": true` on a folder; the control page has a Create column), no `delete` on a single file, and no `"hidden": true` (use `"read": false`, which also removes the name from the view). The full format, every refusal and the reasons are in [docs/project-policy.md](docs/project-policy.md). `vajra doctor` says whether the rights can be enforced here.

### Coding agents

`vajra` opens your shell, confined, and you start `claude`, `opencode` or `codex` from it. Each agent gets exactly the directories it keeps its login, settings and history in, and nothing beside them (never `~/.local`, `~/.config` or the home directory). The guard prints what it granted.

Those grants are made when the shell starts, and a process cannot be given more rights later, so the shell grants every agent at once. **Inside one shell, one agent can read another agent's login.**

A shell is also where a project gets read-only by default: without a `.vajra.json`, the agent can read the project but not edit it (see the policy above).

| Agent | Writable | Notes |
|-------|----------|-------|
| `claude` | `~/.claude`, `~/.claude.json`, `~/.cache/claude-cli-nodejs`; follows `CLAUDE_CONFIG_DIR` | Tested with a real `claude` in an isolated home. Its install directory stays read-only, so it cannot rewrite itself. It wants a lock file and a temp file for `~/.claude.json` in your home directory, which stays closed, so it updates the file in place without the lock: run one session at a time. |
| `opencode` | data, state and cache under `~/.local/share`, `~/.local/state`, `~/.cache`; follows `XDG_*` | Tested with the real `opencode` and its real sessions. Its config directory is **read-only**, so it cannot edit its own settings or add plugins. |
| `codex` | `~/.codex`; follows `CODEX_HOME` | Checked with the real `codex` 0.162 (run with a scratch home, not logged in): it starts, makes the symlinks to itself that it needs in `~/.codex/tmp`, and gets the sandbox notice. It applies a sandbox of its own, which stacks inside this one. |
| `pi` | `~/.pi/agent`; follows `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` | Checked with the real `pi` (the `@earendil-works/pi-coding-agent` package, run with a scratch home, not logged in): it writes only under its agent directory. |

**Telling the agent it is sandboxed.** The kernel's wording for a refused write, "Read-only file system" or "Permission denied", says nothing about a policy, and an agent that takes it for a broken disk goes looking for a way past (remounting, `sudo`, a writable copy in `/tmp`). So each shell carries a notice for the agent: what it can write, what is hidden, that a refusal is the policy and not a fault, that it must not try to get around it, and that it should stop and tell you which path it needed so you can allow it on the control page. It is handed over by a small launcher for each agent that sits first on `PATH` inside the shell: `claude` and `pi` get `--append-system-prompt`, `opencode` gets its `instructions` config, and `codex` gets `-c developer_instructions=...`. Each way was checked against the agent itself, and it is rebuilt for each restart so it names the current rules. `sudo`, `su`, `doas`, `mount` (when it would change something), `umount`, `fusermount`, `unshare`, `nsenter` and `chroot` answer with the same message and exit 1.

This is advice to the agent, not enforcement: the sandbox is what stops it, and an agent that runs `/usr/bin/sudo` by full path gets the kernel's own refusal.

Only directories that already exist are granted, so log in or run the agent once, unguarded, before guarding it. The agent's install directory is granted read and run, so it starts from inside the shell. A program with no profile cannot write its own state, because the `--allow-write` option went with the `guard` command. If something fails with "Permission denied", that is the guard working; add the path you trust.

## What it does not do

- **The network is not restricted.** A confined agent can still send the project, or anything it can read, over the network. This is the biggest gap.
- **A hidden name cannot be inside a writable folder.** A writable folder is shared with the real project, so every name in it shows. `vajra` refuses that policy; hide the folder itself or make it read-only.
- **The environment is passed through unchanged**, including any tokens exported in your shell.
- **`.git`, `node_modules` and `target` are read and run only.** The project policy does not reach inside them, so `npm install` and similar cannot write there under the guard. Change history for rollback exists in `packages/sandbox` but is not connected.
- **No audit log** of what the command did.

Platform: **Linux only**, kernel 5.13+ (Landlock) and bubblewrap. `sudo` is needed once on Ubuntu 24.04 and later, for the AppArmor profile above.

## What else exists

| Piece | Status |
|-------|--------|
| `vajra`: a shell confined to a project | Landlock and seccomp are tested against the real kernel. The view (bubblewrap) is tested as a plan, and the end-to-end test through bubblewrap **has not been run**: it needs the AppArmor profile above, and it skips without it |
| `vajra doctor`: can this machine enforce it? | Built, tested |
| Landlock confinement in the native addon | Built, tested |
| Glob rules and `.vajra-sandbox.json` in `packages/sandbox` | Built, tested, a library API. **`vajra` does not read it**; it reads `.vajra.json` |
| Change history for rollback | Built, tested, not connected |
| Freeze and thaw a process tree | Built, tested, not connected |

## Layout

| Folder | What |
|--------|------|
| `packages/native` | Rust (napi) addon: Landlock, running a command with a deadline, path and env handling, secret redaction |
| `packages/sandbox` | TypeScript: the policy (rules, config file), the platform check, change history, process-tree freezing |
| `packages/vajra` | The `vajra` command: the shell (`src/cli/shell.ts`), the view (`src/view/`, which turns the policy into bubblewrap mounts), the guard engine (`src/guard/`, which applies Landlock and seccomp and starts the shell) and `doctor` |

Working rules are in [AGENTS.md](AGENTS.md), how to build and contribute in [CONTRIBUTING.md](CONTRIBUTING.md), the security policy in [SECURITY.md](SECURITY.md), and design decisions and reference in [docs/](docs/README.md).

## History

The previous design (a Developer that plans, a Manager that schedules, parallel Workers) was removed in commit `5916ddd`. It is in the history before that commit, for example at `9f3be45`.
