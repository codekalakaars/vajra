# Vajra

A lightweight Linux sandbox for running AI CLI agents (opencode, claude, codex, …)
inside a project without exposing your secrets.

Run `vajra launch` in a Node.js project and you get a sandboxed shell where the
agent:

- sees **only the project directory** (Landlock LSM) — your home dir and the
  rest of the filesystem are blocked;
- reads **empty `.env` files** — every env-like file is masked with a read-only
  bind mount, and a generated `.sample.env` shows the variable *names* only;
- starts with a **clean environment** — host env vars (and the API keys in
  them) are stripped;
- gets a **private `/tmp`** and its own PID namespace;
- can still **run the app**: `vajra-run` asks the vajra supervisor (outside the
  sandbox) to run `npm run dev` with the real `.env` injected. Output streams
  back with secret values replaced by `[REDACTED:KEY]` — the app gets the
  secrets, the agent never does.

```
┌─ vajra supervisor (unsandboxed) ── holds real .env, runs the app ─┐
│                                                                   │
│   unix socket ▲ "run dev" / output (redacted)                     │
│               │                                                   │
└─── sandbox ───┴───────────────────────────────────────────────────┘
     shell → opencode → edits code, runs `vajra-run`, sees no secrets
```

## Status

Pre-release / experimental. Linux only (kernel 5.13+ with Landlock; full
enforcement on 6.2+).

## Install

```bash
git clone https://github.com/codekalakaars/vajra && cd vajra
make install        # release build → /usr/local/bin + setcap
```

`vajra` carries `CAP_SYS_ADMIN` (file capability) to create namespaces without
root. Its companion `vajra-run` stays uncapped so it can run inside the
sandbox.

## Usage

```bash
cd ~/my-node-app          # has package.json and .env
vajra launch
```

The first launch scans for env files and asks which is the real one and which
is the sample (Enter accepts the detected defaults); choices are saved to
`.vajra.toml` so later launches go straight in. Then, inside the sandbox:

```bash
opencode                  # or any agent — toolchain dirs are auto-allowed
vajra-run                 # run the app (dev script, falls back to start)
vajra-run build           # any package.json script
vajra-run --stop          # stop a running dev server
exit                      # leave; vajra cleans up
```

Flags: `--env <file>` / `--sample <file>` (skip the picker), `--allow <dir>`
(extra read+execute dir, repeatable), `--reconfigure` (re-run the picker).

Edit your real `.env` normally from outside the sandbox — the supervisor
re-reads it on every `vajra-run`. bun / pnpm / yarn are detected from the
lockfile.

## Try it

```bash
make demo     # sandbox around examples/demo-app, fake secrets included
```

## Security model

Vajra protects against an agent **accidentally or casually** reading secrets:
`cat .env` is empty, host env is stripped, files outside the project are
unreachable, and app output is scrubbed. It does *not* fully defend against an
agent that deliberately writes exfiltration code (e.g. encoding secrets before
printing them) — the same limitation CI log masking has. Network access is
currently unrestricted (agents need their LLM APIs). Review what the agent
commits.

## Development

```bash
make build    # debug build + setcap (needed after every rebuild)
cargo test    # unit tests
make demo     # end-to-end check
```

CI runs build, clippy (deny warnings), and tests on every push and PR.

## License

[Apache 2.0](LICENSE)
