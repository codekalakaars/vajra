# A virtual view of the project, for exact per-path rights

Decision record and plan. This page is written while the decision is open; when it is
settled, the settled parts move into [project-policy.md](project-policy.md) and the
README, and this page shrinks to the reasoning behind them.

## What is being proposed

Instead of enforcing per-path rights with Landlock alone, the confined command sees the
project through a filtered view: a mount served by a trusted process, where each file and
folder appears exactly as the policy says it should. Landlock stays, and becomes the outer
wall that makes the view inescapable.

Three things become possible that the kernel cannot express, all three listed as limits in
[project-policy.md](project-policy.md#why-the-policy-is-limited):

1. **A real `hidden`.** Today `"read": false` leaves the name visible in a listing and
   `stat` still finds it, because Landlock can close a file but not remove a name from a
   directory listing. A view simply does not list the name.
2. **`delete` on a single file.** Removing one file needs delete on its folder, which also
   removes its neighbours. The view deletes the one file and nothing else.
3. **Taking a right away below a folder that has it.** `src/` writable with `src/gen/` not
   is refused today, because the kernel only adds rights downward. The view can say no.

## What is not being proposed

The view is not an alternative to kernel confinement. A filesystem that is only a filter in
front of the real one is bypassable by the first process that opens the real path directly,
and `LD_PRELOAD`, language-level shims and in-process proxies are worse still: `git`,
`rg` and `git credential` never call the shim. This repository refuses to add anything that
looks like a sandbox and is not one, so the view is only worth building with Landlock
underneath it.

The network is still untouched, the environment is still passed through, and this changes
nothing about either.

## How it would work

```
guard (unconfined, trusted)
  ├─ mounts the view at <tmp>/vajra-guard-XXXX/view, served by a child process
  ├─ applies Landlock: system paths, PATH dirs, agent state, TMPDIR, and the view
  │               — but NOT the real project
  └─ starts the command with cwd = the view

command (confined)
  └─ sees only the view; the real project path is denied by Landlock
```

The two layers split the job:

| | Landlock | The view |
|---|---|---|
| Home, `~/.ssh`, other projects, `/tmp` | denies | not involved |
| System programs, PATH, agent state, devices | grants | not involved |
| The project: which path, read/write/delete, visible or not | grants the view as a whole | decides, per path |

The consequence has to be stated plainly: inside the project, the enforcing component
becomes the view server, not the kernel. Everything the kernel was guaranteeing about the
project — no take-aways, no single-file delete, a name that is unlisted is the same as a
name that is unreadable — becomes a property of trusted code, so the code has to earn it.
The kernel still guarantees that the command cannot go around the view.

### Ordering and teardown

- The mount happens before Landlock is applied, because confinement must not stop the guard
  from mounting. The server is a child of the guard and dies with it; `process.rs` already
  has `pdeathsig` for exactly this.
- The mount point lives in the guard's private temporary directory, which the server
  already cleans up when the guard is gone.
- If the mount fails, the guard refuses to start. There is no silent fallback to the
  Landlock-only guard, because the two modes grant different things: a policy that says
  `"hidden": true` run in Landlock-only mode would leak the name.

## What the view server has to get right

This is the whole risk of the proposal, so it belongs in the plan and not in a ticket.

- **Never trust an incoming path.** Reject `..`, absolute paths and NUL. The kernel hands
  the server a path inside the mount; anything that is not clean under the project root
  after normalisation is an error, not a chance to be forgiving.
- **No TOCTOU.** Resolving a name and then opening it by name leaves a window. Open the
  real file through a directory fd on the project root with `openat2`, resolving
  `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, and `fstat` the result to confirm it is the file
  the policy was decided for.
- **Symlinks.** A symlink inside the view that points outside the project must be followed
  only if the target is readable under the policy, and it must never be followed to a name
  the policy hides. Simplest correct answer: symlinks are resolved server-side against the
  real tree and re-checked, which is what `.vajra.json` already does by refusing to give a
  rule to a symlink.
- **Denials look like absence.** A file that may not be read is `ENOENT` on lookup, not
  `EACCES`, so a name that is hidden does not appear. A file that may not be written is
  `EACCES`.
- **Hardlinks.** A hardlink to a file outside the project would otherwise smuggle it in.
  Check the resolved inode against the policy on open, not just the name.
- **It is one process with the real project open.** Nothing else may have it open: the
  Landlock ruleset grants the view, never the real project, so the only process that can
  write the real files is the one enforcing the policy on them.

## Cost

- **It is a dependency.** FUSE from Rust means `fuser` (a protocol crate, no async runtime;
  the addon has none today) or `fuse3` (needs tokio). This is the first third-party
  dependency in `packages/native`, and it is the reason to benchmark before committing.
- **Every file operation crosses into userspace.** `node` builds, `git status`, `rg` over a
  large tree. The view must be benchmarked on a real repo before the decision is settled,
  and attribute caching has to be measured, not assumed.
- **`/dev/fuse` must exist**, and `fusermount3` must be installed and working. Both are
  present on the machine this was written on; neither is guaranteed everywhere, which is
  why the refusal rule above is absolute.
- **The native walker stops being the enforcer of project rights.**
  `permissions.rs::effective` and `permits.rs::apply_per_file_rules` walk the project and
  hand each existing path its rights. The view resolves on demand instead, so the walk's
  limits — depth 8, `.git`/`node_modules`/`target` not walked — stop being kernel
  constraints and become policy decisions. They must first stay as they are, to keep
  behaviour the same: under the guard, `npm install` still cannot write `node_modules`.

## Rights resolution, once, not three times

Today the same question is answered in three places: `project-policy.ts` decides
inheritance for validation, `permissions.rs::effective` decides it at enforcement, and
`permits.rs` walks to apply it. With a view there should be one resolver in the native
layer that both the view and the (still existing) Landlock-only path call, and
`project-policy.ts` should validate against the same rules rather than its own copy.

## Plan

Ordered so each phase can be stopped without leaving the repository in a state that looks
guarded and is not.

0. **Record the decision** — this page. Nothing is built before the benchmark in phase 1.
1. **Benchmark and prove the wall.** A read-only view that shows the whole project
   unchanged, run under the existing guard, on a repo with a large `node_modules`. Two
   gates: (a) the command cannot open the real project path — a new test asserting
   `EACCES` on the real path while the view works; (b) the slowdown on a real command
   (`git status`, a `tsc` build, an `rg`) is measured and written down. If the cost is
   unacceptable, stop here and the record says why.
2. **Move the rights into the view.** The view serves exactly what `.vajra.json` says;
   Landlock keeps the outer wall and stops carrying per-file project rules.
   `project-policy.ts` keeps validating; the four refusals become conditional on the view
   being active instead of absolute.
3. **The three new rights, in this order:** real `hidden` (the one people are asking for),
   `delete` on a single file, and taking a right away below a folder that has it. Each
   needs a test in `guard-project-policy.test.mjs` that fails today and passes with the
   view, and each needs the refusal removed from `project-policy.ts` so the file no longer
   promises something it does not do.
4. **`vajra doctor` reports the view**: `/dev/fuse`, `fusermount3`, and whether a mount can
   be made, so a machine that cannot run it is known before a guard is attempted.

Tests carry over: the existing guard tests assert real denials against the real kernel, and
each of them must pass in both modes. The new ones are for escapes — `..`, absolute path,
symlink out, hardlink in, a name that must not appear — because those are the tests that
decide whether the view is a sandbox or a filter.

## What this deliberately does not do

Copy-on-write, where the agent writes into an overlay and nothing reaches the drive until
it is applied. It is the same machinery and it was considered and left out: it changes what
a write *means*, which is a bigger decision than how a path is filtered, and it should be
proposed on its own once exact per-path control exists.
