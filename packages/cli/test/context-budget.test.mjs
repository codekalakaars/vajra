import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Measured against this repo itself: the regression these tests pin (index
// budget never reaching the model, tree outgrowing the summary) passed every
// existing test, so only real numbers on a real tree catch it.
const repoRoot = join(import.meta.dirname, '..', '..', '..')

// Imported by package subpath, not by a path into dist/. The package root is a
// side-effecting executable — importing it would run the CLI — so these two
// internals are published as explicit subpaths instead.
const { buildInitialPromptContext } = await import('@codekalakaars/vajra-cli/agent/developer')
const { scanProject } = await import('@codekalakaars/vajra-cli/native')
const { buildNestedTree, deriveIndexBudget, MIN_INDEX_BUDGET_CHARS, MAX_INDEX_BUDGET_CHARS } =
  await import('@codekalakaars/vajra-agent-core')

// One measurement shared by every test below — indexing the repo is the
// expensive part and the suite should pay for it once.
const summaryIndex = []
const ctx = buildInitialPromptContext(repoRoot, summaryIndex, 'openai/gpt-4o')
const files = scanProject(repoRoot).filter((entry) => !entry.isDir)

test('the summary budget is derived from the model context window, not fixed at 4,000', () => {
  assert.equal(ctx.summaryBudget, deriveIndexBudget(128000))
  assert.ok(ctx.summaryBudget >= MIN_INDEX_BUDGET_CHARS)
  assert.ok(ctx.summaryBudget <= MAX_INDEX_BUDGET_CHARS)
  assert.ok(ctx.summaryBudget > 4000, `budget ${ctx.summaryBudget} must exceed the old fixed cap`)
  assert.ok(
    ctx.summaryText.length > 4000,
    `formatted summary ${ctx.summaryText.length} must exceed the old 4,000-char cap`,
  )
})

test('on this repo the Developer indexes more than 7.5% of the files', () => {
  assert.ok(summaryIndex.length > 0, 'the index must not be empty')
  const coverage = summaryIndex.length / files.length
  assert.ok(
    coverage > 0.075,
    `indexed coverage is ${summaryIndex.length}/${files.length} = ${(coverage * 100).toFixed(1)}%, ` +
      'expected above 7.5%',
  )
})

test('the tree is smaller than both the summary budget and the summary index', () => {
  assert.ok(
    ctx.tree.length < ctx.summaryBudget,
    `tree ${ctx.tree.length} chars must be under budget ${ctx.summaryBudget}`,
  )
  assert.ok(
    ctx.tree.length <= ctx.summaryText.length,
    `tree ${ctx.tree.length} chars must not outgrow summary ${ctx.summaryText.length}`,
  )
})

test('the tree renders at the explicit four-level depth', () => {
  // packages/cli/src/agent/developer.ts — four directories below the root, so
  // it is only named when the caller passed depth 4 rather than a shallower cap.
  assert.ok(ctx.tree.includes('developer.ts'), 'a four-deep file must be named in the tree')
})

test('when the tree cannot fit it shallows out instead of starving the index', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-treefit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // Five directories of files the summary skips (.min.js), so the index stays
  // empty while the depth-4 tree would name every one of them. The budget must
  // survive untouched — the tree is what gives way.
  const deep = join(dir, 'a', 'b', 'c', 'd', 'e')
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(deep, 'deep.min.js'), 'x = 1\n')
  writeFileSync(join(deep, 'other.min.js'), 'y = 2\n')

  const scanned = scanProject(dir)
  assert.ok(
    scanned.some((e) => e.path === 'a/b/c/d/e/deep.min.js'),
    'the fixture file must be five levels deep for this to mean anything',
  )

  const index = []
  const fixtureCtx = buildInitialPromptContext(dir, index, 'openai/gpt-4o')

  assert.equal(
    fixtureCtx.summaryBudget,
    deriveIndexBudget(128000),
    'the index budget must not shrink to make room for the tree',
  )
  assert.ok(!fixtureCtx.tree.includes('deep.min.js'), 'a five-deep name must be cut')
  assert.ok(fixtureCtx.tree.includes('a/'), 'the root area itself is still named')
  assert.ok(
    fixtureCtx.tree.length < buildNestedTree(scanned, 4).length,
    `tree must be shallower than depth 4, got ${fixtureCtx.tree.length} vs ${buildNestedTree(scanned, 4).length}`,
  )
})

test('every model at or above 128k gets the same budget, and on this repo it costs nothing', () => {
  // deriveIndexBudget saturates: 128k, 200k and 256k windows all clamp to
  // MAX_INDEX_BUDGET_CHARS, so a larger window buys no more index. That is only
  // defensible while the cap is not the binding constraint — measured here
  // rather than assumed. The repo lost the experimental packages (454 files),
  // so the whole index now renders in roughly a third of the cap.
  const saturated = [128000, 200000, 256000].map(deriveIndexBudget)
  assert.deepEqual([...new Set(saturated)], [MAX_INDEX_BUDGET_CHARS])

  const full = []
  const fullCtx = buildInitialPromptContext(repoRoot, full, 'zen/space-bunny-free')
  const rendered = fullCtx.summaryText.length

  assert.ok(
    rendered * 2 < MAX_INDEX_BUDGET_CHARS,
    `the cap is now binding: the full index renders ${rendered} chars against a ` +
      `${MAX_INDEX_BUDGET_CHARS} budget, so raising it would buy real coverage ` +
      'and the saturation decision needs revisiting',
  )
  assert.ok(
    full.length > 0 && full.length <= files.length,
    `indexed ${full.length} entries from ${files.length} scanned files`,
  )
})
