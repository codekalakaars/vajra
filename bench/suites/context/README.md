# Context-management bench suite

This suite is built to stress the Worker's context management, not concurrency
or scheduling. The existing `wide`, `chain`, `fan` and `mixed` suites are small
enough that their tasks use only a few percent of the model's window; this one
pushes the `context-lookup` task toward the window by giving it twelve large
reference files in its context pack.

## What it measures

| Task | What it stresses |
|------|------------------|
| `context-library` | A small pack and a simple edit; baseline per-Worker speed. |
| `context-consumer` | A downstream task whose pack includes the file the first task wrote; measures handoff cost. |
| `context-lookup` | A pack that includes ~1.3 MB of reference JSON. This is where `packWindowShare`, pack degradation, `elision`, `checkpoints` and `seekRatio` show up. |

The reference files are generated deterministically by `generate.mjs`. They are
shuffled across twelve files so a correct `lookup(id)` implementation must scan
them at runtime rather than rely on the pack alone.

## Running it

```bash
pnpm build:all
node packages/vajra/dist/cli/index.js bench bench/suites/context
```

## Tuning with it

`bench/sweeps/context-management.json` varies `packWindowShare`, `elision` and
`checkpoints` against this suite only:

```bash
node bench/tune.mjs bench/sweeps/context-management.json --dry-run
```

Because the suite deliberately overfills the pack at low `packWindowShare`, the
sweep will show when degradation starts hurting `seekRatio` or `roundsToFirstEdit`,
and whether the compaction ladder recovers runs that would otherwise overflow.
