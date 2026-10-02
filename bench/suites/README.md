# Bench suites

Four fixed projects. `vajra bench <suite>` copies a suite's `fixture/` into a
temporary directory, runs the suite's `plan.json` over it with the Workers
arranged as `bench/config.json` says, copies `accept/` in afterwards and runs
those tests over whatever the tasks left behind. A run passes when every task
completed **and** the acceptance command passes; anything else is a failed run.

Nothing here needs an npm dependency: the tasks, the tests and the acceptance
command are all `node` and the built-in test runner.

## One suite

```
<suite>/
  plan.json    the tasks, in the shape a Developer proposes them, and the
               command that decides the run
  fixture/     the project as a run finds it, copied to the run directory
  accept/      the acceptance tests, copied in after the run
  solution/    the reference result: what the fixture looks like when it is done
```

`solution/` is an **overlay**, not a whole project: it holds the files a
finished run leaves different, and a check lays it over a fresh copy of
`fixture/`. Anything a task does not change stays where the fixture put it.
`vajra bench` never reads `solution/`; only the test that checks the suites does.

### The acceptance command

`plan.json` carries it, in argv, because a bench run spawns it with no shell:

```json
"acceptance": { "command": "node", "args": ["--test", "accept/wide.test.mjs"], "timeoutMs": 120000 }
```

run in the run directory once `accept/` has been copied to `<run>/accept/`. The
test files are named outright: with no shell there is nothing to expand a glob,
and `node --test <dir>` runs the directory as a file and fails.
`packages/cli/test/bench-suites.test.mjs` runs exactly this, so it is the
working specification of what a run must do with these four directories.

### The tests a task is judged by

Every task owns one file, `fixture/tests/task-<task-id>.test.mjs`, and its
`verify` command is

```
node --test tests/task-<task-id>.test.mjs
```

That command is the task's success criterion at run time, and it is also the
plan's `proves-change` evidence: `vajra bench` runs every one of them against
the untouched fixture before the run starts, and `validatePlan` refuses a plan
whose command already passes there. Two rules keep it honest:

- **the Worker may read its own test and may not write it.** The test is in the
  task's `context`, never in `writeFile`, so a task cannot pass by weakening the
  test that judges it.
- **`accept/` is out of reach of every task.** It is copied in after the run, so
  no Worker can read or change the thing that decides whether the run passed.

The acceptance tests compose the tasks: they check behaviour no single task test
covers, and every assertion in them follows from what some task's instructions
asked for. A Worker that did exactly what it was told passes them.

### The plan

`plan.json` is a Developer plan: `summary`, `acceptance` and `tasks`, each task
built from `context` / `edits` / `verify`. It also carries the same plan lowered
— `instructions`, `readFile`, `writeFile`, `deleteFile`, `createDir`,
`validation` — because the scheduler, the leases and the Worker's prompt read
those, and a suite should bench the plan whether the runner lowers it or passes
it through. `packages/cli/test/bench-suites.test.mjs` fails when the two forms
disagree.

Two things follow from that and are worth knowing before changing a plan:

- a task that creates a file gets `op: 'create'` and no anchor; a task that
  changes one gets `op: 'modify'` and an anchor copied verbatim from
  `fixture/`, which must appear exactly once in it. A task that changes a file
  an earlier task created has nothing to anchor to, and takes no anchor.
- `readLocks: exclusive` leases every file a task names, reads included, so two
  tasks that only read the same file cannot run together. That is what `mixed`
  exists to measure: `mixed-format-wrap` and `mixed-validate-check` write
  different files and both read `src/parse.js`.

## The four suites

| Suite | Tasks | Files | What it measures |
|-------|-------|-------|-------------------|
| `wide` | 8, all independent, one wave | 8 modules | `concurrency`, and nothing else |
| `chain` | 4, each waiting for the last, four waves | 1 module | per-task speed: nothing to overlap |
| `fan` | 1, then 6, then 1 that waits for all six | 8 modules | scheduling around a bottleneck |
| `mixed` | 10 over 4 modules, six waves | 4 modules | `scheduleOrder`, `readLocks`, `concurrency` |

## Adding one

1. `fixture/` — a `package.json` (`{"type": "module"}`, nothing else), a `src/`
   directory that already exists (a Worker cannot create the parent of a file it
   writes) and one test per task under `tests/`.
2. `solution/` — the finished `src/`, which every task test and the acceptance
   tests must pass.
3. `accept/` — tests that fail on `fixture/` and pass on the solution, over
   behaviour the tasks were asked for, plus the `acceptance` command in
   `plan.json` that runs them.
4. `plan.json` — the tasks, each with one edit, one own-test `verify` command,
   and dependencies that put the tasks in the wave shape the suite is for.
5. Add the suite directory and the test picks it up; there is no list to update.

Then run `node --test test/bench-suites.test.mjs` from `packages/cli`. It
checks every suite above without a model: `validatePlan` on the plan and the
evidence a run builds, both sides of every command the suite runs, and both
halves of the acceptance rule.
