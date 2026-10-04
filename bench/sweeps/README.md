# Sweeps

## Purpose

A sweep runs the same task suites under many arrangements of Workers and prints
which arrangement wins. It is the only part of the tuning plan that spends hours
of machine time, so it is deliberately dumb: it writes one whole
`bench/config.json` candidate per arrangement, runs every suite against every
candidate one run at a time, appends every result to a file, and prints the
score. It decides nothing, and it never writes `bench/config.json` — a human does
that, at the end, once a sweep has said what to write.

Everything here is data. A sweep file names the suites, the keys to vary with
their values, and how many times to repeat each combination. Adding a tuning
step means adding a file here, never editing the runner.

## Table of Contents

- [Running a Sweep](#running-a-sweep)
- [The Sweep File](#the-sweep-file)
- [What Is Here](#what-is-here)
- [The Report](#the-report)
- [Reading a Result](#reading-a-result)
- [What Disqualifies an Arrangement](#what-disqualifies-an-arrangement)
- [Results](#results)

## Running a Sweep

```bash
pnpm build:all                                    # the sweep measures dist/, not src/
node bench/tune.mjs bench/sweeps/baseline.json  # ~20 runs, hours if a suite is slow
```

Check what a sweep would do before paying for it:

```bash
node bench/tune.mjs bench/sweeps/cpu-thresholds.json --dry-run
```

Useful options while iterating on a step:

| Option | What it does |
|--------|--------------|
| `--suites wide,chain` | Run only these suites, whatever the file lists |
| `--repetitions 1` | One run per combination instead of the file's own count |
| `--bench-cmd <cmd>` | The command that speaks `bench`; the built CLI by default |
| `--results <file>` | Append somewhere else, to keep a day's file whole |
| `--candidates <dir>` | Keep the candidate configs, to see what a run was given |
| `--keep-candidates` | Keep the temp directory that holds them |
| `--root <dir>` | Point the sweep at another repository holding `bench/` |
| `--verbose` | Let each run's own output through as it happens |
| `--dry-run` | Print the runs, write nothing |

Exit 0 when the sweep completed, 1 when it completed without a single successful
run, 2 when nothing ran at all: a bad sweep file, an unreadable config, or a
suite that is not there.

## The Sweep File

```json
{
  "name": "cpu-thresholds",
  "suites": ["wide", "chain", "fan", "mixed"],
  "repetitions": 5,
  "base": {},
  "vary": {
    "cpuPauseAt": [0.8, 0.9, 0.97],
    "cpuResumeAt": [0.6, 0.75]
  }
}
```

| Key | Required | What it does |
|-----|----------|--------------|
| `suites` | yes | Suite names under `bench/suites/`, each of which must exist before the first run |
| `vary` | yes | Keys to vary, each with its values. Every combination of them is one arrangement, first key varying slowest |
| `repetitions` | yes | Runs per arrangement per suite. Five while tuning, ten to confirm |
| `base` | no | Values applied to `bench/config.json` before the varied keys — how a sweep is run against a config that has already been tuned |
| `name` | no | Names the sweep and its results file; defaults to the file's own name |

Every key in `vary` and `base` must already be a key of `bench/config.json`:
a candidate is a whole config file, and one with a missing key would be refused
by every run of it. An empty `vary` means one arrangement — the base config as it
stands — which is what `baseline.json` and `confirm.json` are.

The order of the runs is fixed, so a sweep that is interrupted and resumed over
the same day appends to the same file without interleaving itself:

```
for each arrangement          (the combinations of vary)
  for each suite              (the order in suites)
    for each repetition       (1 … repetitions)
      vajra bench <suite> --config <candidate> --out <result.json>
```

One run at a time. Two runs sharing a machine would measure contention between
them instead of the arrangement under test.

## What Is Here

The tuning order from the plan: the arrangement before the Worker, so that a
per-Worker win is not measured on top of a losing arrangement.

| File | Varies | Question it answers |
|------|--------|---------------------|
| `baseline.json` | nothing | What does the config as committed score, and does anything fail at all? Fix reliability before tuning anything |
| `cpu-thresholds.json` | `cpuPauseAt`, `cpuResumeAt` | How hot the CPU may run before Workers are paused, and how far it must cool before they resume or new ones start. There is no Worker count: CPU and RAM decide |
| `worker-memory.json` | `workerMemMb` | How much RAM to set aside per Worker before a reading shows what it used: too low admits a burst that swaps, too high holds Workers back |
| `schedule-order.json` | `scheduleOrder` | Which ready task should get the next free slot |
| `read-locks.json` | `readLocks` | Whether tasks that only read one file may run together |
| `worker-model.json` | `workerModel` | Which model is fastest per round, and which one retries most |
| `worker-reasoning.json` | `workerReasoning` | Whether thinking per round is paid for or wasted on suite-sized tasks |
| `preload-reads.json` | `preloadReads` | Whether a read round is worth more than the prompt it costs |
| `task-timeout.json` | `taskTimeoutSec` | How quickly a stalled attempt is worth cutting off |
| `warm-sandboxes.json` | `warmSandboxes` | Whether a cold sandbox launch between tasks is worth the memory |
| `context-pack.json` | `contextPack` | Whether starting a Worker from a compiled context pack beats starting it from a list of paths, and what it does to the seek ratio |
| `compaction.json` | `elision`, `checkpoints` | Whether the compaction ladder helps at all on these suites. Run it only when `peak ctx` says the tasks are near the window: both rungs off is the baseline, and a suite that never approaches the window will show them costing rounds for nothing |
| `respawn.json` | `respawnContext` | Whether telling a retry what the last attempt did is worth the prompt it costs. Run it after the baseline, because it only pays when something is actually failing |
| `context-management.json` | `packWindowShare`, `elision`, `checkpoints` | Runs the `context` suite alone to tune pack sizing and the compaction ladder under real window pressure. The `context` task's pack includes ~1.3 MB of reference files; at `packWindowShare=0.5` it crosses `elideAt`, and at `0.8` it crosses `compactAt` |
| `confirm.json` | nothing, `base` holds the winner | Does the combined winner hold at ten out of ten on every suite |

Keep each winner: put it in the next sweep's `base`, or in `bench/config.json`,
so the following step measures one thing at a time. The sweeps are written
against the committed config with no `base`, which is the right starting point
only for the first two steps.

`confirm.json` ships with an empty `base`, which confirms whatever
`bench/config.json` says now. Fill it with the combined winner to confirm before
the winner is committed.

## The Report

One block per suite, one row per arrangement, fastest qualifying arrangement on
top:

```
sweep worker-memory · 4 arrangement(s) × 1 suite(s) × 5 repetition(s)
results   bench/results/2026-10-02-worker-memory.jsonl

ok is successful runs out of repetitions; the medians count successful runs only.
Anything short of 100% is disqualified, however fast it looked.

wide
values             ok  median    p90   idle  peak ctx  seek
workerMemMb=256   5/5   1.82s  1.82s   55ms       31%   0%
workerMemMb=512   5/5   1.99s  1.99s   71ms       29%   0%
workerMemMb=1024  5/5   2.38s  2.38s   92ms       30%   0%
workerMemMb=128  9/10   1.71s  1.71s   48ms       33%   4%  disqualified

winners
  wide      workerMemMb=256

disqualified
  wide      workerMemMb=128  9/10 — task-3 failed after 3 attempts
```

| Column | Meaning |
|--------|---------|
| `values` | The varied keys of that arrangement, or `(base config)` |
| `ok` | Successful runs out of repetitions — the success rate, as a number that can be compared |
| `median` | Median `wallMs` of the successful runs. This is the score |
| `p90` | The slowest successful run, or the second slowest at ten repetitions |
| `idle` | Median `idleMs`: summed time tasks were ready (dependencies settled, files free) but not running |
| `peak ctx` | The fullest any Worker's context got, as a share of its model's window, over every run including failed ones. Near 100% means suite tasks are big enough that Worker compaction is worth building |
| `seek` | The worst `seekRatio` of any run: the share of a Worker's reading, searching and listing that the pack did not already hold. The worst of a run rather than the median, because one task whose pack was missing everything is enough to make the arrangement under it wrong |

Two numbers read together decide what to do next. A `median` near the run's
`criticalPathMs` means the arrangement is done and only per-Worker speed is left
to win. A high `idle` next to a much larger `median` means tasks were ready and
waiting, and the arrangement is still losing time. A high `seek` next to a
slower `median` means the pack is missing what Workers look for, and the run's
`mostMissedPaths` says which files to put in it.

`median`, `p90` and `idle` count successful runs only. A failed run has no
score, so folding its wall clock into a median would reward arrangements that
fail quickly. `peak ctx` and `seek` take the worst run of the set instead,
including the failed ones: a run that overflowed its window or searched for
everything is exactly what those two columns exist to catch.

## Reading a Result

The per-run result file has what the sweep table cannot show. The numbers that
decide the context steps are per task:

```json
{
  "seekRatio": 0.18,
  "packTokens": 2140,
  "packSectionsCut": 0,
  "packPaths": ["src/a.ts", "src/types.ts"],
  "staleAnchors": 0,
  "relocatedAnchors": 1,
  "redundantReads": 2,
  "roundsToFirstEdit": 1,
  "elisions": 0,
  "compactions": 0,
  "stuck": 0
}
```

| Field | What a number means |
|-------|---------------------|
| `roundsToFirstEdit` | Model rounds before the first write, or `null` when the Worker never wrote. This is the number the pack is meant to move: a Worker that writes on round 1 did not spend its first round finding the code |
| `seekRatio` | Reads, searches and listings of a path the pack did not carry, over all tool calls. A search names no single path, so it always counts: it is a reach for something the pack did not hand over |
| `redundantReads` | Reads of a path the pack already showed, made before the Worker changed it. After a change, a re-read is the Worker keeping its copy honest and is not counted |
| `packSectionsCut` | Parts of the pack the budget degraded. Non-zero is fine — the budget exists — but it means something was not shown |
| `staleAnchors` | Anchors the plan could no longer find. Non-zero means the plan was written against a tree that has since moved, and the suite should be fixed rather than tuned |
| `elisions`, `compactions`, `stuck` | What the ladder did. `stuck` above zero disqualifies the arrangement whatever its median |

`mostMissedPaths` at the top level is the answer to a high `seekRatio`: it is the
list of paths Workers reached for that no pack held.

## What Disqualifies an Arrangement

An arrangement qualifies only if it succeeds on every repetition. One failure
disqualifies it, however fast its median is, and the row is marked as such both
in place and in a list at the end of the report, with the reason it failed. The
usual cause is not the arrangement at all — a model that cannot finish a task, a
tool-call budget that is too tight, a timeout that cuts a slow but finishing
attempt — which is why the baseline comes first and why a disqualified row is
worth reading rather than deleting.

A tie marks every row with that median as `best`, and the winners list names the
first of them. The `p90` and `idle` columns are there to choose between them: a
plan that does not say how to break a tie should not have a sweep inventing one.

## Results

Every run appends one line to `bench/results/<date>-<sweep>.jsonl`, in the order
it ran:

```json
{"sweep":"worker-memory","date":"2026-10-02","suite":"wide","repetition":1,
 "values":{"workerMemMb":256},"exitCode":0,"result":{ … the BenchResult … }}
```

`result` is the run's own output file, whole, including the full config it ran
with. A run that produced no result — exit 2, or a bench command that would not
start — is recorded as a failure with the reason in `result.failureReason`, so a
lost run is visible rather than missing. Nothing is ever rewritten: a second
sweep on the same day appends to the same file.