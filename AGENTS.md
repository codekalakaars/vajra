# Working in this repository

Vajra is a CLI that confines a shell so an AI coding agent running inside it cannot act outside a policy. Read [README.md](README.md) first: it says what is built and what is not.

## Where things are

| You want to change | Look in |
|--------------------|---------|
| The `vajra` command and its options | `packages/vajra/src/cli/` |
| What the guard allows, and how it launches the command | `packages/vajra/src/guard/` (`policy.ts`: the rules; `project-policy.ts`: the `.vajra.json` rights; `agents.ts`: the claude, opencode and codex profiles) |
| The `.vajra.json` format, and why some policies are refused | `docs/project-policy.md` (keep it in step with `project-policy.ts`) |
| What exists in the shell (bubblewrap mounts built from `.vajra.json`) | `packages/vajra/src/view/` (`plan.ts`: the mounts; `launch.ts`: the bubblewrap command line) |
| The control page (rights per path, saved to `.vajra.json`) and the restart that applies them | `packages/vajra/src/panel/` (`rights.ts`: the edits; `server.ts`: the loopback server; `page.ts`: the page) and `packages/vajra/src/session/resume.ts` (finding the running agent, its resume option) |
| The notice to the agent inside the shell, and the launchers that deliver it | `packages/vajra/src/session/notice.ts` (add an agent's launcher only after checking, with the agent itself, how it takes instructions) |
| File rules, the policy file, secret masking, change history, process freezing | `packages/sandbox/src/` |
| Landlock, seccomp (`seccomp.rs`), running a command with a deadline, paths, env, redaction (Rust) | `packages/native/src/` |

## Commands

```bash
pnpm install
pnpm build:all     # builds everything, including the Rust addon (needs a Rust toolchain)
pnpm test:all      # every package's tests
```

Tests import from `dist/`, so **build before testing**. To run one package: `pnpm --filter @codekalakaars/vajra-sandbox test`. To run one file: `node --test packages/sandbox/test/<name>.test.mjs`.

## Rules

- The guard denies by default: a new grant needs a reason, and nothing under the home directory is granted without being named. A test in `packages/vajra/test/guard.test.mjs` (run through `test/support/guard-cli.mjs`, since the public command has no `guard`) shows each denial against the real kernel; `guard-project-policy.test.mjs` does the same for each right in `.vajra.json`.
- Rights inside the project come only from `.vajra.json` (`guard/project-policy.ts`). A profile or `--allow-*` grant inside the project is dropped with a note, because the kernel adds rights up and would override the file. Rules the kernel cannot express exactly are refused at startup, never loosened.
- An agent profile names only that agent's own directories, never a shared parent (`~/.local`, `~/.config`, `~/.cache`). Check where a new agent keeps its state with the agent itself (for example `opencode debug paths`) or `strace`, not from memory.
- The view, Landlock and seccomp are separate layers and none stands in for another: a path hidden by the view must also be denied by Landlock, and a new seccomp rule needs a test that fails without the filter (see the `seccomp:` tests in `guard.test.mjs`).
- The control page is the only way rules change while Vajra is running, and it must stay unreachable from the shell: loopback only, a token on every API call, Host and Origin checks, and file names put on the page as text, never as HTML.
- Linux only. Confinement is the product: do not add a fallback that looks like a sandbox and is not one. The sandbox needs kernel 5.13+ (Landlock).
- A guard that cannot be enforced must say so and refuse, never degrade silently.
- Comments explain *why*, in plain sentences. Input is validated by hand; no new dependencies without a reason.
- Never commit unless asked.
