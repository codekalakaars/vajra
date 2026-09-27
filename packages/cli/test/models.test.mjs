import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * The model catalog is the one place that decides what the UI is allowed to
 * claim about a model: which reasoning levels exist, how big the context window
 * is, and whether the gateway is serving the model to this key at all. Every
 * test here runs offline through an injected fetch — a suite that reaches
 * models.dev is a suite that fails on a train.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const {
  parseCatalog,
  reasoningLevelsFor,
  clampReasoning,
  contextLimitFor,
  modelView,
  modelHint,
  describeModel,
  listModels,
  loadModelCatalog,
  refreshModelStatus,
  hasCatalog,
  resetCatalog,
  formatTokens,
} = await import(pathToFileURL(join(dist, 'models', 'catalog.js')).href)
const { getModelLimit } = await import(pathToFileURL(join(dist, 'agent', 'context-window.js')).href)
const { reasoningParamsFor } = await import(pathToFileURL(join(dist, 'agent', 'chat.js')).href)

/** A models.dev payload with one model per reasoning mode, plus noise. */
const PAYLOAD = {
  anthropic: { api: 'https://api.anthropic.com', models: { 'claude-x': { id: 'claude-x' } } },
  opencode: {
    api: 'https://opencode.ai/zen/v1',
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        description: 'Agent-ready GPT',
        family: 'gpt',
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: '2026-03-05',
        modalities: { input: ['text', 'image'], output: ['text'] },
        open_weights: false,
        limit: { context: 272000, output: 64000 },
        cost: { input: 2.5, output: 15, cache_read: 0.25 },
      },
      'toggler': {
        id: 'toggler',
        name: 'Toggler',
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }],
        limit: { context: 200000, output: 10000 },
        cost: { input: 0, output: 0 },
      },
      'budgeter': {
        id: 'budgeter',
        name: 'Budgeter',
        reasoning: true,
        reasoning_options: [{ type: 'budget_tokens' }],
        limit: { context: 128000 },
        cost: { input: 0.3, output: 1.2 },
      },
      'plain': {
        id: 'plain',
        name: 'Plain',
        reasoning: false,
        tool_call: true,
        limit: { context: 128000 },
        cost: { input: 0, output: 0 },
      },
      'broken': { name: 'No Id Or Limits' },
    },
  },
  'opencode-go': {
    api: 'https://opencode.ai/zen/go/v1',
    models: {
      'glm-5.3': {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        limit: { context: 1000000, output: 131072 },
        cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
      },
    },
  },
}

const jsonResponse = body => ({ ok: true, status: 200, json: async () => body })

/** A private VAJRA_HOME, so the cache never touches the real one. */
function inHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'vajra-models-'))
  try {
    return fn(home, { VAJRA_HOME: home })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * Put a catalog in place the way a real session gets one: written to the cache
 * by a fetch, then read back on start. Going through the cache file rather than
 * a test-only setter means the lookup tests also exercise the path that runs in
 * production, and nothing in the module exists only for tests.
 */
async function prime(catalog) {
  return inHome(async (home, env) => {
    writeFileSync(
      join(home, 'models.json'),
      `${JSON.stringify({ version: 1, fetchedAt: Date.now(), catalog })}\n`,
    )
    resetCatalog()
    await loadModelCatalog({
      env,
      now: Date.now(),
      fetchImpl: async () => {
        throw new Error('a primed catalog must not refetch')
      },
    })
  })
}

test('parseCatalog keys models by our provider prefix, not the upstream name', () => {
  const catalog = parseCatalog(PAYLOAD, 1000)
  assert.deepEqual(Object.keys(catalog.models).sort(), [
    'go/glm-5.3',
    'zen/broken',
    'zen/budgeter',
    'zen/gpt-5.4',
    'zen/plain',
    'zen/toggler',
  ])
  assert.equal(catalog.fetchedAt, 1000)
})

test('parseCatalog keeps the facts the screen draws and skips other providers', () => {
  const catalog = parseCatalog(PAYLOAD)
  const gpt = catalog.models['zen/gpt-5.4']
  assert.equal(gpt.name, 'GPT-5.4')
  assert.equal(gpt.wireId, 'gpt-5.4')
  assert.equal(gpt.context, 272000)
  assert.equal(gpt.output, 64000)
  assert.equal(gpt.cost.input, 2.5)
  assert.equal(gpt.cost.cacheRead, 0.25)
  assert.equal(gpt.toolCall, true)
  assert.equal(gpt.attachment, true)
  assert.equal(gpt.structuredOutput, true)
  assert.equal(gpt.temperature, true)
  assert.equal(gpt.openWeights, false)
  assert.equal(gpt.releaseDate, '2026-03-05')
  assert.deepEqual(gpt.modalities, { input: ['text', 'image'], output: ['text'] })
  assert.equal(catalog.models['anthropic/claude-x'], undefined, 'a provider we cannot reach is not in the catalog')
})

test('parseCatalog survives a payload that is not a payload', () => {
  for (const junk of [null, undefined, 42, 'text', [], { opencode: null }, { opencode: { models: 5 } }]) {
    const catalog = parseCatalog(junk)
    assert.deepEqual(catalog.models, {}, `expected no models from ${JSON.stringify(junk)}`)
  }
})

test('parseCatalog defaults a missing limit rather than reporting zero', () => {
  const catalog = parseCatalog(PAYLOAD)
  assert.equal(catalog.models['zen/broken'].context, 128000, 'an unknown window falls back, it does not claim zero')
  assert.equal(catalog.models['zen/broken'].name, 'No Id Or Limits')
})

test('reasoning mode comes from the model, not from a fixed list', () => {
  const catalog = parseCatalog(PAYLOAD)
  assert.equal(catalog.models['zen/gpt-5.4'].reasoningMode, 'effort')
  assert.equal(catalog.models['zen/toggler'].reasoningMode, 'toggle')
  assert.equal(catalog.models['zen/budgeter'].reasoningMode, 'budget')
  assert.equal(catalog.models['zen/plain'].reasoningMode, 'none')
  assert.equal(catalog.models['zen/plain'].reasoning, false)
})

test("a model's own efforts are the dial, with 'none' and unknown values dropped", () => {
  const catalog = parseCatalog({
    opencode: {
      api: 'https://opencode.ai/zen/v1',
      models: {
        m: {
          id: 'm',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['xhigh', 'none', 'low', 'ludicrous', 'max'] }],
        },
      },
    },
  })
  assert.deepEqual(catalog.models['zen/m'].reasoningEfforts, ['low', 'xhigh', 'max'])
})

test('reasoning levels are per model, and always start at off', async () => {
  await prime(parseCatalog(PAYLOAD))
  assert.deepEqual(reasoningLevelsFor('zen/gpt-5.4'), ['off', 'low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(reasoningLevelsFor('go/glm-5.3'), ['off', 'low', 'high', 'max'])
  assert.deepEqual(reasoningLevelsFor('zen/toggler'), ['off', 'high'])
  assert.deepEqual(reasoningLevelsFor('zen/budgeter'), ['off'], 'a token budget is not a level we can send')
  assert.deepEqual(reasoningLevelsFor('zen/plain'), ['off'], 'a model that cannot reason offers nothing')
  assert.deepEqual(reasoningLevelsFor('zen/never-heard-of-it'), ['off', 'low', 'medium', 'high'])
})

test('clampReasoning drops a level the model would reject', async () => {
  await prime(parseCatalog(PAYLOAD))
  assert.equal(clampReasoning('zen/gpt-5.4', 'max'), 'off', 'gpt-5.4 has no max')
  assert.equal(clampReasoning('zen/gpt-5.4', 'xhigh'), 'xhigh')
  assert.equal(clampReasoning('zen/plain', 'high'), 'off')
  assert.equal(clampReasoning('zen/toggler', 'xhigh'), 'off')
  assert.equal(clampReasoning('unknown/model', 'high'), 'high', 'no facts means no clamping')
})

test('the context window is the model\'s own, and the meter agrees', async () => {
  await prime(parseCatalog(PAYLOAD))
  assert.equal(contextLimitFor('zen/gpt-5.4'), 272000)
  assert.equal(contextLimitFor('go/glm-5.3'), 1000000)
  assert.equal(getModelLimit('zen/gpt-5.4'), 272000, 'compaction budgets the same window the meter shows')
  assert.equal(getModelLimit('zen/never-heard-of-it'), 128000)
})

test('a request carries the reasoning shape the model documents', async () => {
  await prime(parseCatalog(PAYLOAD))
  assert.deepEqual(reasoningParamsFor('zen/gpt-5.4', 'xhigh'), { reasoning_effort: 'xhigh' })
  assert.deepEqual(reasoningParamsFor('zen/gpt-5.4', 'off'), {}, 'off sends nothing')
  assert.deepEqual(reasoningParamsFor('zen/gpt-5.4', 'max'), {}, 'a level outside the vocabulary sends nothing')
  assert.deepEqual(reasoningParamsFor('zen/toggler', 'high'), { reasoning: { enabled: true } })
  assert.deepEqual(reasoningParamsFor('zen/toggler', 'off'), {})
  assert.deepEqual(reasoningParamsFor('zen/plain', 'high'), {}, 'a model that cannot reason gets no parameter')
  assert.deepEqual(reasoningParamsFor('zen/budgeter', 'high'), {})
  assert.deepEqual(
    reasoningParamsFor('zen/never-heard-of-it', 'high'),
    { reasoning_effort: 'high' },
    'no catalog entry falls back to what the gateway has always accepted',
  )
})

test('an explicit toggle overrides what the dial would have inferred', async () => {
  await prime(parseCatalog(PAYLOAD))
  assert.deepEqual(reasoningParamsFor('zen/toggler', 'off', true), { reasoning: { enabled: true } })
  assert.deepEqual(reasoningParamsFor('zen/toggler', 'high', false), {})
})

test('the cache is written once and read back without a fetch', async () => {
  await inHome(async (home, env) => {
    resetCatalog()
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return jsonResponse(PAYLOAD)
    }
    await loadModelCatalog({ env, fetchImpl, now: 1_000 })
    assert.equal(calls, 1)
    assert.equal(hasCatalog(), true)
    const written = JSON.parse(readFileSync(join(home, 'models.json'), 'utf-8'))
    assert.equal(written.version, 1)
    assert.equal(written.catalog.models['zen/gpt-5.4'].context, 272000)

    // A second load inside the TTL is served from the cache: no second fetch.
    resetCatalog()
    await loadModelCatalog({ env, fetchImpl, now: 2_000 })
    assert.equal(calls, 1, 'a fresh cache must not hit the network')
    assert.equal(contextLimitFor('zen/gpt-5.4'), 272000)

    // Past the TTL it refetches, because a model released this morning is the
    // whole point of not hardcoding the list.
    await loadModelCatalog({ env, fetchImpl, now: 2_000 + 13 * 60 * 60 * 1000 })
    assert.equal(calls, 2)
    resetCatalog()
  })
})

test('a failed fetch keeps yesterday\'s catalog instead of emptying it', async () => {
  await inHome(async (home, env) => {
    resetCatalog()
    await loadModelCatalog({ env, fetchImpl: async () => jsonResponse(PAYLOAD), now: 1_000 })
    resetCatalog()
    await loadModelCatalog({
      env,
      now: 2_000 + 13 * 60 * 60 * 1000,
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    assert.equal(contextLimitFor('zen/gpt-5.4'), 272000, 'a stale catalog beats no catalog')
    resetCatalog()
  })
})

test('a fetch that returns junk or nothing is not written over a good cache', async () => {
  await inHome(async (home, env) => {
    resetCatalog()
    for (const body of [{}, { opencode: { api: 'https://opencode.ai/zen/v1', models: {} } }]) {
      await loadModelCatalog({ env, fetchImpl: async () => jsonResponse(body), now: 1_000 })
    }
    assert.equal(hasCatalog(), false)
    assert.equal(readFileSync.length > 0, true)
    resetCatalog()
  })
})

test('a cold start with no cache still answers, with the conservative defaults', async () => {
  await inHome(async (_home, env) => {
    resetCatalog()
    await loadModelCatalog({
      env,
      fetchImpl: async () => {
        throw new Error('offline')
      },
      now: 1_000,
    })
    assert.equal(hasCatalog(), false)
    assert.equal(modelView('zen/gpt-5.4'), null, 'the UI is told it does not know, rather than given a guess')
    assert.deepEqual(reasoningLevelsFor('zen/gpt-5.4'), ['off', 'low', 'medium', 'high'])
    assert.equal(getModelLimit('zen/gpt-5.4'), 128000)
    resetCatalog()
  })
})

test('availability comes from the gateway listing, not from models.dev', async () => {
  await prime(parseCatalog(PAYLOAD))
  const seen = []
  await refreshModelStatus('key', {
    fetchImpl: async (url) => {
      seen.push(url)
      if (url.includes('/go/')) return jsonResponse({ data: [{ id: 'glm-5.3' }] })
      return jsonResponse({ data: [{ id: 'gpt-5.4' }, { id: 'plain' }] })
    },
  })
  assert.deepEqual(seen.sort(), [
    'https://opencode.ai/zen/go/v1/models',
    'https://opencode.ai/zen/v1/models',
  ])
  const catalog = parseCatalog(PAYLOAD)
  assert.equal(catalog.models['zen/gpt-5.4'].status, 'unknown')
  assert.equal(modelView('zen/gpt-5.4').status, 'available')
  assert.equal(modelView('zen/toggler').status, 'unavailable', 'in the catalog but not served: not a choice')
  assert.equal(modelView('go/glm-5.3').status, 'available')
})

test('an unavailable model is hidden from the picker but reported by /model', async () => {
  await prime(parseCatalog(PAYLOAD))
  await refreshModelStatus('key', {
    fetchImpl: async url =>
      url.includes('/go/') ? jsonResponse({ data: [] }) : jsonResponse({ data: [{ id: 'gpt-5.4' }] }),
  })
  const offered = listModels().map(info => info.id)
  const everything = listModels({ includeUnavailable: true }).map(info => info.id)
  assert.ok(!offered.includes('zen/toggler'), 'a model this key cannot reach is not offered')
  assert.ok(offered.includes('zen/gpt-5.4'))
  assert.ok(everything.includes('zen/toggler'), 'but /model can still show it, flagged')
  assert.match(describeModel(listModels({ includeUnavailable: true }).find(i => i.id === 'zen/toggler')), /unavailable/)
})

test('a listing that fails marks the status unknown and says why', async () => {
  await prime(parseCatalog(PAYLOAD))
  await refreshModelStatus('key', {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  const view = modelView('zen/gpt-5.4')
  assert.equal(view.status, 'unknown')
  assert.match(view.statusDetail, /503/, 'a failed check is reported, not hidden')
  assert.ok(listModels().length > 0, 'a network blip must not empty the picker')
})

test('no key means unchecked, not unavailable', async () => {
  await prime(parseCatalog(PAYLOAD))
  let called = false
  await refreshModelStatus(undefined, {
    fetchImpl: async () => {
      called = true
      return jsonResponse({ data: [] })
    },
  })
  assert.equal(called, false, 'a keyless machine has no listing to ask for')
  assert.equal(modelView('zen/gpt-5.4').status, 'unknown')
  assert.match(modelView('zen/gpt-5.4').statusDetail, /no OPENCODE_API_KEY/)
})

test('the screen view carries what the sidebar draws and nothing else', async () => {
  await prime(parseCatalog(PAYLOAD))
  const view = modelView('zen/gpt-5.4')
  assert.deepEqual(Object.keys(view).sort(), [
    'context',
    'cost',
    'description',
    'id',
    'levels',
    'name',
    'reasoning',
    'reasoningMode',
    'status',
    'toolCall',
  ])
  assert.equal(view.context, 272000)
  assert.deepEqual(view.levels, ['off', 'low', 'medium', 'high', 'xhigh'])
  assert.ok(JSON.parse(JSON.stringify(view)), 'the view has to survive the snapshot it is sent in')
})

test('a picker row is built from the model, not from a template', async () => {
  await prime(parseCatalog(PAYLOAD))
  const gpt = listModels({ includeUnavailable: true }).find(info => info.id === 'zen/gpt-5.4')
  assert.match(modelHint(gpt), /^272k ctx · reasoning low\/medium\/high\/xhigh · \$2\.5\/\$15$/)
  const plain = listModels({ includeUnavailable: true }).find(info => info.id === 'zen/plain')
  assert.match(modelHint(plain), /no reasoning/)
  assert.match(modelHint(plain), /free/)
  // One line, and it carries what a choice turns on: the window, the reasoning
  // vocabulary, the price, and whether the gateway is serving it to this key.
  assert.match(
    describeModel(gpt),
    /zen\/gpt-5\.4\s+·\s+reasoning low\/medium\/high\/xhigh\s+·\s+272k ctx\s+·\s+\$2\.5\/\$15 per Mtok/,
  )
  assert.match(describeModel(plain), /no reasoning/)
  assert.match(describeModel(plain), /free/)
})

test('formatTokens is compact and exact where it can be', () => {
  assert.equal(formatTokens(1000000), '1M')
  assert.equal(formatTokens(1048576), '1.0M')
  assert.equal(formatTokens(272000), '272k')
  assert.equal(formatTokens(128000), '128k')
  assert.equal(formatTokens(999), '999')
})

test('models sort free-first, then by id, so a picker is usable', async () => {
  await prime(parseCatalog(PAYLOAD))
  const ids = listModels({ includeUnavailable: true }).map(info => info.id)
  assert.deepEqual(ids, [
    'zen/broken',
    'zen/plain',
    'zen/toggler',
    'go/glm-5.3',
    'zen/budgeter',
    'zen/gpt-5.4',
  ])
})

test.after(() => resetCatalog())
