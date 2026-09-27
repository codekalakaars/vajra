import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The store's reasoning dial and the model facts it publishes.
 *
 * Both used to be constants: four levels, cycled in the same order for every
 * model, and a sidebar that measured every conversation against one hardcoded
 * window. These tests pin the part that is now derived — the dial belongs to
 * the model, and a level the model rejects never survives a model change.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const storeUrl = pathToFileURL(join(dist, 'tui', 'session', 'store.js')).href
const catalogUrl = pathToFileURL(join(dist, 'models', 'catalog.js')).href
const { SessionStore } = await import(storeUrl)
const { parseCatalog, resetCatalog, loadModelCatalog } = await import(catalogUrl)

const PAYLOAD = {
  opencode: {
    api: 'https://opencode.ai/zen/v1',
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
        tool_call: true,
        limit: { context: 272000, output: 64000 },
        cost: { input: 2.5, output: 15, cache_read: 0.25 },
      },
      toggler: {
        id: 'toggler',
        name: 'Toggler',
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }],
        limit: { context: 200000 },
        cost: { input: 0, output: 0 },
      },
      plain: {
        id: 'plain',
        name: 'Plain',
        reasoning: false,
        tool_call: true,
        limit: { context: 128000 },
        cost: { input: 0, output: 0 },
      },
    },
  },
}

/**
 * A store over a model the catalog knows, without touching the network: the
 * cache is written directly and read back by the loader.
 */
async function storeFor(model) {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'vajra-store-'))
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({ version: 1, fetchedAt: Date.now(), catalog: parseCatalog(PAYLOAD) }),
  )
  resetCatalog()
  await loadModelCatalog({
    env: { VAJRA_HOME: dir },
    now: Date.now(),
    fetchImpl: async () => {
      throw new Error('a primed catalog must not refetch')
    },
  })
  const store = new SessionStore({ model, projectDir: '/tmp' })
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the dial is the model\'s own levels, walked in order and wrapping', async () => {
  const { store, cleanup } = await storeFor('zen/gpt-5.4')
  try {
    assert.deepEqual(store.getSnapshot().reasoningLevels, ['off', 'low', 'medium', 'high', 'xhigh'])
    const seen = []
    for (let i = 0; i < 6; i++) seen.push(store.cycleReasoning())
    assert.deepEqual(seen, ['low', 'medium', 'high', 'xhigh', 'off', 'low'])
  } finally {
    cleanup()
  }
})

test('a model with no reasoning has nothing to cycle', async () => {
  const { store, cleanup } = await storeFor('zen/plain')
  try {
    assert.deepEqual(store.getSnapshot().reasoningLevels, ['off'])
    assert.equal(store.cycleReasoning(), 'off', 'ctrl-r on a non-reasoning model is a no-op, not an error')
  } finally {
    cleanup()
  }
})

test('a toggle model cycles between off and on', async () => {
  const { store, cleanup } = await storeFor('zen/toggler')
  try {
    assert.deepEqual(store.getSnapshot().reasoningLevels, ['off', 'high'])
    assert.equal(store.cycleReasoning(), 'high')
    assert.equal(store.cycleReasoning(), 'off')
  } finally {
    cleanup()
  }
})

test('switching models drops a level the new one would reject', async () => {
  const { store, cleanup } = await storeFor('zen/gpt-5.4')
  try {
    store.setSettings({ reasoning: 'xhigh' })
    assert.equal(store.getSnapshot().reasoning, 'xhigh')
    store.setSettings({ model: 'zen/plain' })
    assert.equal(store.getSnapshot().reasoning, 'off')
    assert.deepEqual(store.getSnapshot().reasoningLevels, ['off'])
    store.setSettings({ model: 'zen/gpt-5.4' })
    assert.deepEqual(store.getSnapshot().reasoningLevels, ['off', 'low', 'medium', 'high', 'xhigh'])
  } finally {
    cleanup()
  }
})

test('the snapshot carries the model facts the screen draws', async () => {
  const { store, cleanup } = await storeFor('zen/gpt-5.4')
  try {
    const { modelInfo } = store.getSnapshot()
    assert.equal(modelInfo.name, 'GPT-5.4')
    assert.equal(modelInfo.context, 272000)
    assert.equal(modelInfo.cost.input, 2.5)
    assert.equal(modelInfo.toolCall, true)
    assert.deepEqual(modelInfo.levels, ['off', 'low', 'medium', 'high', 'xhigh'])
    assert.equal(modelInfo.status, 'unknown', 'nothing has been checked yet, and it says so')
  } finally {
    cleanup()
  }
})

test('refreshModelInfo is what makes a late catalog visible', async () => {
  const { store, cleanup } = await storeFor('zen/never-heard-of-it')
  try {
    assert.equal(store.getSnapshot().modelInfo, null)
    assert.deepEqual(store.getSnapshot().reasoningLevels, ['off', 'low', 'medium', 'high'])
    store.setSettings({ model: 'zen/gpt-5.4' })
    assert.equal(store.getSnapshot().modelInfo.context, 272000)
  } finally {
    cleanup()
  }
})

test.after(() => resetCatalog())
