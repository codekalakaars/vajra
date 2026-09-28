# State on Disk

## Purpose

Everything Vajra persists between runs lives in one directory — `~/.vajra` —
plus two or three dotfiles inside the project you point it at. This document is
the inventory: what each file is, what it holds, who writes it, whether it holds
a secret, and what deleting it costs you.

It is a description of the code as it stands, not a design document. Every path
here was read out of the source; where behaviour is undecided it is marked
`TODO`.

**Scope:** this documents the shipped `vajra` CLI in `packages/cli` — the part
of the system that runs today. The rest of this directory describes the harness
runtime as designed, whose own storage is still an open question.

## Table of Contents

- [Where the home is](#where-the-home-is)
- [Everything in the home](#everything-in-the-home)
- [The database](#the-database)
- [The summary index cache](#the-summary-index-cache)
- [The model catalog cache](#the-model-catalog-cache)
- [What lives in your project](#what-lives-in-your-project)
- [What is deliberately not there](#what-is-deliberately-not-there)
- [Secrets](#secrets)
- [Resetting](#resetting)
- [Environment variables](#environment-variables)

## Where the home is

`$VAJRA_HOME` if it is set and non-blank, otherwise `~/.vajra`
(`packages/cli/src/home.ts:11-14`). It is resolved on every call rather than
cached at startup, so a test can point it at a temporary directory and change it
between calls. Anything that creates the home creates it with mode `0700`; the
mode is applied only when the directory does not already exist, so a home
directory you created yourself keeps the mode you gave it.

The variable exists for tests and portable installs. There is no XDG support and
no per-user system-wide location: one process, one home, resolved from the
environment.

## Everything in the home

| Path | Written by | Holds | Mode | Secret |
| --- | --- | --- | --- | --- |
| `config.json` | `/config` or `vajra config -s` (`config.ts:32`) | Saved defaults: `model`, `projectDir`, and each role's own model — `developerModel`, `managerModel`, `workerModel` | `0600` | no |
| `auth.json` | `vajra auth login` (`auth.ts:23`) | `OPENCODE_API_KEY`, in the clear | `0600` | **yes** |
| `vajra.db` | `saveSession` / `appendMessage` (`persist/db.ts:23`) | Sessions and message transcripts (SQLite) | `0600` | transcripts |
| `vajra.db-wal`, `vajra.db-shm` | SQLite, because the connection sets `journal_mode=WAL` (`db.ts:36`) | Write-ahead log and shared-memory index | inherit `0600` | transcripts |
| `index/<fingerprint>.json` | `saveSummaryIndexCache` (`persist/session.ts:398`) | Cached per-file symbol lists and code previews | umask (typically `0644`) | low — see [Secrets](#secrets) |
| `models.json` | `writeCache` (`models/catalog.ts:282`) | Model capabilities from models.dev, plus the gateway's own listing | `0600` | no |

Two of these deserve a note.

`auth.json` is the only file that holds a credential, and it is a plain JSON
file. `vajra auth logout` writes `{}` to it rather than removing it, and there is
no OS keychain integration of any kind — see
[What is deliberately not there](#what-is-deliberately-not-there).

`config.json` and `auth.json` are both written through the same helper, which
creates them `0600` and then `chmod`s them back to `0600` after the write,
because an existing file keeps its original mode. `index/` and the index files
inside it do not go through that helper, so they inherit your umask. That is a
real asymmetry and it is a `TODO` to bring them under the same rule.

## The database

One SQLite file, created on demand and chmod'ed `0600` *before* the first write
so the WAL sidecars inherit the mode. Two tables, no migrations at the SQL
level:

```sql
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  project_dir  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  data         TEXT NOT NULL   -- the whole session record, as JSON
);

CREATE TABLE messages (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,    -- one message, as JSON
  PRIMARY KEY (session_id, seq)
);
```

A session is one row holding its plan, task states, phase, git snapshot and
staleness verdict. A message is one row: the role, the content, and the tool
calls. Schema versioning lives in the JSON (`SESSION_SCHEMA_VERSION`), not in
the database, and a v1 row is migrated forward when it is read. A row whose JSON
no longer parses is reported as `status: 'corrupt'` rather than being dropped.

Sessions are global by id. `project_dir` is a column and an index, not part of
the lookup key, so a session recorded in one checkout can be resumed from
another — which is what the CLI relies on when you `vajra resume <id>` from a
different directory.

Deleting a session deletes its messages with it. Nothing else ever deletes
anything: there is no retention policy, no vacuum, and no pruning
(`TODO` — see [roadmap](../roadmap/README.md)).

## The summary index cache

`index/<fingerprint>.json` is the answer to "what is in this repository", kept
so a session does not rebuild it. The filename is a content-independent
fingerprint: `sha256("<fileCount>:<newest mtime>")`, truncated to 32 hex
characters, from a directory walk to depth 12 that skips `.git`,
`node_modules` and `.vajra` (`persist/session.ts:329`).

Staleness is implicit and free. The file is named after the fingerprint of the
tree it describes, so a tree that has changed produces a different name and the
old file is simply never looked at again; the loader additionally refuses any
file whose recorded fingerprint does not match. The cost is that stale files
accumulate: nothing enumerates `index/` and removes the old ones
(`TODO` — [roadmap](../roadmap/README.md)).

At most one index file is written per session.

## The model catalog cache

`models.json` is the capability table: what each model is called, how big its
context window is, which reasoning levels it accepts, what it costs, and
whether the gateway currently serves it. It is assembled from
`https://models.dev/api.json` plus the gateway's own `/models` listing, and is
treated as fresh for twelve hours. Both fetches are best-effort and happen in
the background; until they land, every lookup falls back to a conservative
default rather than failing a session.

Deleting the file costs one network round trip on the next launch.

## What lives in your project

Vajra's own state does not live in the project. Three dotfiles can, and it is
worth knowing which of them the CLI touches:

| Path | Holds | The `vajra` CLI |
| --- | --- | --- |
| `.vajra-sandbox.json` | Per-file permission config: default permissions, pattern rules, allowed tools, read/write path grants | **reads only** — the `vajra-sandbox` binary writes it |
| `.vajra-perms.json` | The same idea in the form the native addon reads | **reads only** |
| `.vajra-profile-<pid>.sh` | A generated shell profile used by `vajra-sandbox secure` | does not use it; deletes itself on exit |

Everything else the agent writes — source edits, created files, deleted files —
is the agent doing its job inside your project, and is not Vajra bookkeeping.
The project directory is the workspace, not a state directory.

`.vajra/` inside a project is legacy. Sessions moved to the database; the
constant survives only as a name to skip while fingerprinting. If you have one
left over from an older build, nothing reads it.

## What is deliberately not there

Stated as plainly as the inventory, because the absence is a decision:

- **No OS keychain.** No macOS Keychain, no libsecret, no Windows Credential
  Manager. `auth.json` at `0600` is the whole credential story.
- **No XDG directories.** No `~/.config/vajra`, no `~/.cache/vajra`, no
  `$XDG_*`, no `%APPDATA%`.
- **No logs, no crash dumps, no telemetry.** There is no log directory and no
  log file; a worker that writes to stdout has its output put in the session
  transcript instead.
- **No lock files.** The file-lock manager is in-memory only, so nothing
  survives a crash — a restart is a clean slate.
- **No OS temp writes.** Production code never writes to the temp directory.
  (Tests do; `pnpm test` drops `.vajra-test-*` directories in your home
  directory by design, because on macOS the temp directory is inside a
  per-user container that the sandbox cannot see.)
- **No automatic cleanup.** Nothing expires. Growth in `index/` and in the
  database is bounded only by what you delete yourself.

## Secrets

Exactly one file holds a credential: `auth.json`. It is `0600`, inside a `0700`
directory, and it is never copied into a project.

Two files hold material you would still rather not publish, even though neither
holds a credential:

- `vajra.db` holds your conversation — every prompt, every answer, tool calls
  and their results. Values that look like secrets are redacted on the way in,
  but a pasted key in a message is not something the database can tell apart
  from prose.
- `index/<fingerprint>.json` holds truncated source previews, and it is *not*
  chmod'ed `0600`. Project `.env` files are excluded from the index, so their
  contents are not in there; ordinary source is.

## Resetting

| Goal | Command |
| --- | --- |
| Forget the stored key | `vajra auth logout` |
| Forget saved defaults | delete `config.json` |
| Forget every session and transcript | delete `vajra.db` (and its `-wal`/`-shm` siblings while no process is running) |
| Rebuild caches from scratch | delete `models.json` and `index/` |
| Forget everything | `rm -rf ~/.vajra` |

## Environment variables

Every environment variable the CLI reads:

| Variable | Effect |
| --- | --- |
| `VAJRA_HOME` | Where state lives. Defaults to `~/.vajra`. |
| `VAJRA_MODEL`, `DEFAULT_MODEL` | Default model, below `config.json` |
| `VAJRA_DEVELOPER_MODEL` | The model the Developer role runs on, below `config.json` |
| `VAJRA_MANAGER_MODEL` | The model the Manager role runs on, below `config.json` |
| `VAJRA_WORKER_MODEL` | The model the Worker role runs on, below `config.json` |
| `VAJRA_PROJECT_DIR` | Default project directory, below `config.json` |
| `OPENCODE_API_KEY` | The API key. See [llm-providers.md](llm-providers.md). |
| `VAJRA_TUI_ENTRY` | Path to the front-end entry point |
| `VAJRA_BUN` | Path to the `bun` binary that runs the front-end |

Model resolution reads the environment before `config.json`, so an exported
variable overrides a saved default without editing it.

The three role models are independent of each other and of `model` (ADR-0010), and
a role with no key of its own runs on `model`. `VAJRA_MANAGER_MODEL` is also the
opt-in that lets the Manager ask the model anything: the Manager is an agent, and
a model configured for it is a model that gets asked.

## See also

- [llm-providers.md](llm-providers.md) — the one provider, and the key that goes with it
- [../testing/gaps.md](../testing/gaps.md) — what about this is not tested yet
- [../permissions/security-model.md](../permissions/security-model.md) — what the sandbox confines
