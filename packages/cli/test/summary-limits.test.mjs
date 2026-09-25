import { test } from 'node:test'
import assert from 'node:assert/strict'
// agent-core is the single home for these pure functions (Group N); the CLI's
// agent/*.ts are shims over it. The package barrel exports all of them, so
// import by package name rather than reaching into dist/ by path.
const {
  extractSymbols,
  deriveIndexBudget,
  formatSummaryIndexHierarchical,
  SYMBOL_CAP,
  MIN_INDEX_BUDGET_CHARS,
  MAX_INDEX_BUDGET_CHARS,
  DEFAULT_INDEX_BUDGET_CHARS,
} = await import('@codekalakaars/vajra-agent-core')
const { buildNestedTree, DEFAULT_TREE_DEPTH } = await import('@codekalakaars/vajra-agent-core')

function makeSymbolContent(count) {
  const lines = []
  for (let i = 0; i < count; i++) {
    lines.push(`export function symbol${i}() { return ${i} }`)
  }
  return lines.join('\n')
}

function makeSummary(count) {
  const entries = []
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(3, '0')
    entries.push({
      path: `src/module${n}.ts`,
      symbols: [`handler${n}`, `helper${n}`],
      preview: `export function handler${n}() {}`,
      lineCount: 10,
      importCount: 1,
      exportCount: 2,
    })
  }
  return entries
}

function dir(path, isDir) {
  return { name: path.split('/').pop(), path, isDir, isMasked: false }
}

const fourDeep = [
  dir('a', true),
  dir('a/b', true),
  dir('a/b/c', true),
  dir('a/b/c/d', true),
  dir('a/b/c/d/deep.ts', false),
]

test('extractSymbols caps per file at 40, not 15', () => {
  assert.equal(SYMBOL_CAP, 40)
  const symbols = extractSymbols(makeSymbolContent(60))
  assert.equal(symbols.length, 40)
  assert.ok(symbols.includes('symbol0'), 'first symbols must survive the cap')
  assert.ok(symbols.includes('symbol39'), 'the 40th symbol must be included')
  assert.ok(!symbols.includes('symbol40'), 'the cap must actually cut')
})

test('extractSymbols honours an explicit cap', () => {
  assert.equal(extractSymbols(makeSymbolContent(20), 7).length, 7)
  assert.equal(extractSymbols(makeSymbolContent(20), 0).length, 0)
})

test('deriveIndexBudget scales with the model context window', () => {
  // 8192 tokens * 4 chars/token * 25% share = 8192 chars
  assert.equal(deriveIndexBudget(8192), 8192)
  assert.equal(deriveIndexBudget(20000), 20000)
  // Huge windows are capped so the index cannot swallow the prompt
  assert.equal(deriveIndexBudget(128000), MAX_INDEX_BUDGET_CHARS)
  assert.equal(deriveIndexBudget(1000000), MAX_INDEX_BUDGET_CHARS)
})

test('deriveIndexBudget never drops below the old fixed budget', () => {
  assert.equal(MIN_INDEX_BUDGET_CHARS, 4000)
  assert.equal(DEFAULT_INDEX_BUDGET_CHARS, 4000)
  assert.equal(deriveIndexBudget(1000), MIN_INDEX_BUDGET_CHARS)
  assert.equal(deriveIndexBudget(0), MIN_INDEX_BUDGET_CHARS)
  assert.equal(deriveIndexBudget(-5), MIN_INDEX_BUDGET_CHARS)
  assert.equal(deriveIndexBudget(NaN), MIN_INDEX_BUDGET_CHARS)
})

test('a bigger budget fits strictly more of the index', () => {
  const summary = makeSummary(400)
  const small = formatSummaryIndexHierarchical(summary, 500)
  const large = formatSummaryIndexHierarchical(summary, 100000)

  assert.ok(small.length < large.length, 'small budget must render less')
  assert.ok(small.length < 700, `small budget must stay near its cap, got ${small.length}`)
  assert.ok(small.includes('module000.ts'))
  assert.ok(!small.includes('module399.ts'), 'last file must not fit a 500-char budget')
  assert.ok(large.includes('module000.ts'))
  assert.ok(large.includes('module399.ts'), 'a wide budget must include the last file')
  assert.ok(large.length <= 100000)
})

test('a budget derived from a 128k window fits a large index', () => {
  const summary = makeSummary(400)
  const budget = deriveIndexBudget(128000)
  const out = formatSummaryIndexHierarchical(summary, budget)
  assert.ok(out.includes('module399.ts'), `budget ${budget} must cover 400 files`)
  assert.ok(out.length <= budget + 100)
})

test('callers that pass no budget keep the old fixed behaviour', () => {
  const summary = makeSummary(400)
  const implicit = formatSummaryIndexHierarchical(summary)
  const explicit = formatSummaryIndexHierarchical(summary, 4000)
  assert.equal(implicit, explicit)
  assert.ok(implicit.length < 4000 + 500)
  assert.equal(formatSummaryIndexHierarchical([]), '(no files indexed)')
})

test('a fixture repo four levels deep is fully represented by default', () => {
  assert.equal(DEFAULT_TREE_DEPTH, 4)
  const tree = buildNestedTree(fourDeep)
  assert.ok(tree.includes('deep.ts'), `four levels must be rendered:\n${tree}`)
  assert.ok(!tree.includes('...'), `nothing collapses at depth 4:\n${tree}`)
})

test('the depth parameter collapses deeper levels on request', () => {
  const shallow = buildNestedTree(fourDeep, 3)
  assert.ok(!shallow.includes('deep.ts'), `depth 3 must cut level 4:\n${shallow}`)
  assert.ok(shallow.includes('...'), 'the cut directory is marked collapsed')
  assert.ok(shallow.includes('d/'), 'the collapsed directory itself is still named')
})

test('five levels deep collapses at the default depth', () => {
  const fiveDeep = [
    ...fourDeep,
    dir('a/b/c/d/e', true),
    dir('a/b/c/d/e/deeper.ts', false),
  ]
  const tree = buildNestedTree(fiveDeep)
  assert.ok(tree.includes('e/'), `level 5 dir must be named:\n${tree}`)
  assert.ok(tree.includes('...'), 'level 5 must be collapsed')
  assert.ok(!tree.includes('deeper.ts'), 'files behind the cut must not render')
})
