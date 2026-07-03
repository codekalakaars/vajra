# Vajra: Sandboxed AI-agent layer with .env lockdown + proxied app runs

## Goal

A developer runs `vajra launch` in a Node.js project and gets a sandboxed shell
where they run an AI CLI agent (e.g. opencode). Inside that sandbox:

- The agent only sees files inside the chosen project folder (Landlock).
- The project's `.env` (and all env-like files) are **locked** — the agent
  cannot read their contents.
- A `.sample.env` (keys only, no values) is auto-generated as a reference for
  the agent if it doesn't exist.
- The agent can still **trigger** app runs (`vajra run`), but the app is
  executed *outside* the sandbox by vajra with the real `.env` loaded — the
  agent sees the app's output, never the secrets.

## Why restructuring is needed

1. **Landlock cannot deny a subpath** of an allowed tree — it's allow-only.
   The project dir is allowed rw, so `.env` inside it would be readable.
   Fix: since the sandbox has a private mount namespace, **bind-mount an empty
   read-only file over each env file** before Landlock is applied. The agent
   sees an empty, unwritable file.
2. **`launch_sandbox()` used to unshare the calling process itself**, so the
   vajra parent ended up inside the sandbox too — no unsandboxed process was
   left to run the app with the real env. Fix: fork first; the child enters
   the sandbox, the parent stays outside as a **supervisor** that holds the
   real `.env` and runs the app on request.

## Architecture

The GUI (Slint) is removed in this iteration: its stated purpose (env-var
management) is covered by the supervisor + `.env` proxying, and dropping Slint
removes the heaviest dependency. Git history keeps the code.

```
vajra launch (in project dir)
├── Supervisor (main process, UNSANDBOXED)
│   ├── scans for env-like files; interactive picker chooses
│   │   original + sample (detected defaults, custom name allowed)
│   ├── generates the sample from the original's keys if missing
│   ├── listens on unix socket <project>/.vajra/run.sock
│   └── on "run" request: parses .env, spawns `npm run <script>`
│       with real env, streams output back, returns exit code
└── Sandbox child (fork)
    ├── unshare(NEWPID | NEWNS), remount /proc private
    ├── bind-mount empty RO file over each env-like file (except sample)
    ├── Landlock restrict to project dir + system paths
    └── exec shell with minimal clean env (PATH, HOME, TERM,
        SHELL, LANG, VAJRA_SOCK) — host env vars stripped
        └── user runs opencode; agent runs `vajra run [script]`
```

### Env file detection and interactive selection

At launch, before the sandbox starts:

1. **Scan**: find every env-like file in the project dir (name matches `.env`,
   `.env.*`, or `*.env`).
2. **Classify defaults**: sample-looking names (`.sample.env`, `.env.sample`,
   `.env.example`, `.env.template`) default to sample; `.env` (or the only
   remaining env file) defaults to original.
3. **Interactive picker**: numbered list for both roles with detected defaults
   preselected (Enter accepts); custom-name entry allowed.
4. `--env <file>` / `--sample <file>` flags skip the prompt; if no env-like
   files exist, launch with no masking (with a warning).

All detected env-like files are masked inside the sandbox **except** the
chosen sample. The sample is generated from the original's keys if missing.

### `vajra run [script]`

Used *inside* the sandbox: connects to the socket at `$VAJRA_SOCK`, sends the
run request, streams the app's stdout/stderr, exits with the app's exit code.
`vajra run --stop` kills a running app. Default script: `dev` if present in
package.json scripts, else `start`.

## Files

| File | Role |
|---|---|
| `src/main.rs` | CLI: `launch` (picker → fork sandbox → supervisor loop → cleanup) and `run` (client) |
| `src/envpick.rs` | Scan project dir for env-like files, classify original/sample defaults, terminal picker |
| `src/envfile.rs` | `.env` parser (KEY=VAL, comments, `export `, quotes) + sample generator |
| `src/sandbox.rs` | Namespaces, /proc remount, `mask_env_files()` bind mounts, clean-env `execve` of shell |
| `src/landlock.rs` | Landlock ruleset: project rw, system paths rx/ro, vajra binary rx |
| `src/supervisor.rs` | Unix socket server; spawns/kills `npm run <script>` with env = host env + parsed `.env` |

## Verification

Throwaway Node app with `.env` (`SECRET=hunter2`) and a `dev` script printing
`process.env.SECRET`:

1. `vajra launch` → picker with correct defaults; `.sample.env` generated with
   `SECRET=`; multiple env files classified and masked correctly.
2. In shell: `cat .env` → empty; writes to it fail; `env` shows no host
   secrets, `VAJRA_SOCK` present; paths outside the project still denied.
3. `vajra run` → output streams, prints `hunter2`, exit code propagates.
4. `vajra run --stop` kills a long-running dev server.
5. `cargo test` passes; exiting the shell cleans up socket and `.vajra/`.

## Assumptions

- The real `.env` is owned/edited by the user, outside the sandbox; vajra
  never writes it and re-reads it on every `vajra run`.
- Node apps only for now; runner is `npm run <script>`.
- Network from inside the sandbox is untouched (the agent needs its LLM API).
