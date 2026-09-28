import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { isolateEachTest, useTempVajraHome } from './_isolate.mjs'

/**
 * ADR-0010: Developer, Manager and Worker each get a model, configured
 * independently, and one `/config` screen sets all three plus the directory.
 *
 * The failure these guard against is not a crash — it is a setting that appears
 * to be honoured. A role that quietly falls back to the default, or a `/config`
 * row that says "default" while the role runs something else, both look like
 * working software from a distance.
 */

isolateEachTest('vajra-roles-')

const configUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'config.js')).href
const menuUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tui', 'session', 'config-menu.js')).href
const rolesUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'roles.js')).href
const {
  clearConfig,
  configSource,
  readConfig,
  resolveDefaultModel,
  resolveRoleModel,
  writeConfig,
} = await import(configUrl)
const {
  configOptions,
  directoryOptions,
  effectiveRoleModel,
  hasOverride,
  itemRole,
  modelPickerOptions,
  CONFIG_ITEMS,
  INHERIT_DEFAULT,
  isWorkingDirectory,
} = await import(menuUrl)
const { planRoleModels, roleReasoningEffort } = await import(rolesUrl)

// Read per test, not once: isolateEachTest points VAJRA_HOME at a fresh
// directory before each one, so a value captured at import time is the wrong one.
const configFile = () => join(process.env.VAJRA_HOME, 'config.json')
const saved = () => JSON.parse(readFileSync(configFile(), 'utf8'))

test('a role with no model of its own runs on the default', () => {
  writeConfig({ model: 'zen/gpt-5.4' })
  for (const role of ['developer', 'manager', 'worker']) {
    assert.equal(resolveRoleModel(role), 'zen/gpt-5.4', `${role} should inherit the default`)
  }
})

test('each role can be given a model of its own, and only that role', () => {
  writeConfig({ model: 'zen/gpt-5.4', workerModel: 'zen/gpt-5.4-mini' })
  assert.equal(resolveRoleModel('worker'), 'zen/gpt-5.4-mini')
  assert.equal(resolveRoleModel('developer'), 'zen/gpt-5.4')
  assert.equal(resolveRoleModel('manager'), 'zen/gpt-5.4')
  // The file holds the override and the fallback, and no copy of the value the
  // other two already get: three copies is how a default stops being one thing.
  assert.deepEqual(Object.keys(saved()).sort(), ['model', 'workerModel'])
})

test('an env var overrides a role the same way it overrides the default', () => {
  writeConfig({ model: 'zen/gpt-5.4', workerModel: 'zen/gpt-5.4-mini' })
  const env = { ...process.env, VAJRA_WORKER_MODEL: 'go/gpt-5.4' }
  assert.equal(resolveRoleModel('worker', env), 'go/gpt-5.4')
  assert.equal(configSource('workerModel', env), 'env')
  assert.equal(configSource('workerModel'), 'config')
  // Only the overridden role moves.
  assert.equal(resolveRoleModel('developer', env), 'zen/gpt-5.4')
})

test('a role goes back on the default by being cleared, not set to nothing', () => {
  writeConfig({ model: 'zen/gpt-5.4', developerModel: 'zen/gpt-5.4-pro' })
  clearConfig(['developerModel'])
  assert.equal(resolveRoleModel('developer'), 'zen/gpt-5.4')
  // Nothing left behind: no empty string for readConfig to reject next time.
  assert.equal('developerModel' in saved(), false)
})

test('a model id that could never run is dropped, not carried', () => {
  // A hand-edited file with a bad model must not stop Vajra from starting on
  // the models that are fine.
  writeConfig({ model: 'zen/gpt-5.4' })
  writeConfig({})
  const raw = JSON.parse(readFileSync(configFile(), 'utf8'))
  raw.workerModel = 'openai/gpt-4o'
  writeFileSync(configFile(), JSON.stringify(raw))
  assert.equal(readConfig().workerModel, undefined)
  assert.equal(resolveRoleModel('worker'), 'zen/gpt-5.4')
})

test('the one screen lists every setting, the default first', () => {
  const options = configOptions({
    defaultModel: 'zen/gpt-5.4',
    roleOverrides: {},
    projectDir: '/home/me/vajra',
  })
  // The default is first because the other three are measured against it, and
  // because the command it replaced (/defaults) made it persist — a setting that
  // used to be saved and is now only shown looks like it works until a restart.
  assert.deepEqual(
    options.map(o => o.value),
    ['model', 'developerModel', 'managerModel', 'workerModel', 'projectDir'],
  )
  assert.deepEqual([...CONFIG_ITEMS], options.map(o => o.value))
})

test('the default row says who follows it', () => {
  const allInheriting = configOptions({
    defaultModel: 'zen/gpt-5.4',
    roleOverrides: {},
    projectDir: '/tmp',
  })[0]
  assert.match(allInheriting.label, /zen\/gpt-5\.4/)
  assert.match(allInheriting.label, /developer, manager, worker follow/)

  // With every role on a model of its own, the default changes nothing today.
  const noneInheriting = configOptions({
    defaultModel: 'zen/gpt-5.4',
    roleOverrides: { developer: 'zen/a', manager: 'zen/b', worker: 'zen/c' },
    projectDir: '/tmp',
  })[0]
  assert.match(noneInheriting.label, /nothing follows it/)
  // And with only one role pinned, that role is named and the others are not.
  const oneInheriting = configOptions({
    defaultModel: 'zen/gpt-5.4',
    roleOverrides: { worker: 'zen/c' },
    projectDir: '/tmp',
  })[0]
  assert.match(oneInheriting.label, /developer, manager follow/)
  assert.doesNotMatch(oneInheriting.label, /worker follow/)
})

test('the default is not a role, and a directory is not a model', () => {
  assert.equal(itemRole('model'), null)
  assert.equal(itemRole('projectDir'), null)
  assert.equal(itemRole('workerModel'), 'worker')
})

test('a role following the default says so, and shows the model it will run', () => {
  const state = { defaultModel: 'zen/gpt-5.4', roleOverrides: {}, projectDir: '/tmp' }
  // Row one is the default now, so the developer is the second row.
  const developer = configOptions(state)[1]
  // The value in play, not the absence of one: "nothing" reads as broken.
  assert.match(developer.label, /zen\/gpt-5\.4/)
  assert.match(developer.label, /default/)
  assert.match(developer.label, /plans your work/)
  assert.equal(hasOverride(state, 'developer'), false)
  assert.equal(effectiveRoleModel(state, 'developer'), 'zen/gpt-5.4')
})

test('a role with its own model stops claiming the default is in play', () => {
  const state = {
    defaultModel: 'zen/gpt-5.4',
    roleOverrides: { worker: 'zen/gpt-5.4-mini' },
    projectDir: '/tmp',
  }
  const worker = configOptions(state).find(o => o.value === 'workerModel')
  assert.match(worker.label, /zen\/gpt-5\.4-mini/)
  assert.doesNotMatch(worker.label, /· default/)
  assert.equal(hasOverride(state, 'worker'), true)
})

test('the directory row shows the directory', () => {
  const dir = configOptions({
    defaultModel: 'zen/x',
    roleOverrides: {},
    projectDir: '/home/me/project',
  }).at(-1)
  assert.equal(dir.value, 'projectDir')
  assert.match(dir.label, /\/home\/me\/project$/)
  assert.equal(itemRole(dir.value), null)
  assert.equal(itemRole('managerModel'), 'manager')
})

test('a model row marks the model in play, and the default is its own choice', () => {
  const options = modelPickerOptions(
    [
      { id: 'zen/a', label: 'zen/a  · 128k ctx' },
      { id: 'zen/b', label: 'zen/b  · 272k ctx' },
    ],
    'zen/b',
  )
  assert.equal(options.length, 2)
  assert.match(options[1].label, /current/)
  assert.doesNotMatch(options[0].label, /current/)
  // Not an empty value: the picker filters on the value, and "" matches
  // everything, which would put "use the default" at the top of every list.
  assert.notEqual(INHERIT_DEFAULT, '')
})

test('the directory list offers real places, without repeating itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'vajra-dirs-'))
  try {
    const here = join(root, 'here')
    const other = join(root, 'other')
    mkdirSync(here)
    mkdirSync(other)
    writeFileSync(join(root, 'a-file'), 'not a directory')
    const options = directoryOptions(
      here,
      other,
      [here, other, join(root, 'a-file'), join(root, 'gone')],
      isWorkingDirectory,
    )
    const values = options.map(o => o.value)
    // The launch dir, the current dir and the recent ones, once each, and the
    // two that are not directories left out — offering a file as a working
    // directory fails on the first tool call, in the user's project.
    assert.deepEqual(values.slice(0, 2).sort(), [here, other].sort())
    assert.equal(new Set(values).size, values.length)
    assert.equal(values.includes(join(root, 'a-file')), false)
    assert.equal(values.includes(join(root, 'gone')), false)
    // The parent is last: it is the move you make after the project turns out
    // to be a subdirectory, never the first answer.
    assert.equal(values.at(-1), root)
    assert.match(options.find(o => o.value === here).label, /\(current\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a role with no model of its own is the behaviour that existed before', () => {
  const plan = planRoleModels({ defaultModel: 'zen/gpt-5.4' })
  assert.equal(plan.developer, 'zen/gpt-5.4')
  assert.equal(plan.manager, 'zen/gpt-5.4')
  assert.equal(plan.worker, 'zen/gpt-5.4')
  assert.deepEqual(plan.overrides, {})
})

test('the three roles can be told apart, and only the manager needs a reason', () => {
  const plan = planRoleModels({
    defaultModel: 'zen/gpt-5.4',
    developerModel: 'zen/gpt-5.4-pro',
    managerModel: 'zen/gpt-5.4-nano',
    workerModel: 'go/gpt-5.4-mini',
  })
  assert.equal(plan.developer, 'zen/gpt-5.4-pro')
  assert.equal(plan.manager, 'zen/gpt-5.4-nano')
  assert.equal(plan.worker, 'go/gpt-5.4-mini')
  // Naming a model for the Manager is the opt-in ADR-0010 describes, so the
  // Manager asks the model without anyone passing a flag.
  assert.equal(plan.managerAsks, true)
  // §4's flag still works on its own, for a manager on the default model.
  assert.equal(planRoleModels({ defaultModel: 'zen/x', useMasterLlm: true }).managerAsks, true)
  assert.equal(planRoleModels({ defaultModel: 'zen/x' }).managerAsks, false)
})

test('a role model this build cannot run stops the session, naming the role', () => {
  const plan = planRoleModels({ defaultModel: 'zen/gpt-5.4', workerModel: 'openai/gpt-4o' })
  assert.deepEqual(plan.invalid, [{ role: 'worker', model: 'openai/gpt-4o' }])
  // And it does not also quietly become the model the worker runs on.
  assert.equal(plan.worker, 'zen/gpt-5.4')
})

test('one reasoning dial is clamped per model, not sent to all three', async () => {
  // A level picked on a model that takes xhigh is not a level a model that
  // takes a toggle accepts, and sending it is a request the provider rejects.
  // The clamp needs the catalog to know which is which, so the test primes it.
  const catalogUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'models', 'catalog.js')).href
  const { parseCatalog, resetCatalog, loadModelCatalog } = await import(catalogUrl)
  const payload = {
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
          cost: { input: 0, output: 0, cache_read: 0 },
        },
      },
    },
  }
  // The clamp reads the catalog, and the catalog is a file. A primed one is
  // written and loaded rather than stubbed, so the test exercises the same
  // lookup the session does.
  const dir = mkdtempSync(join(tmpdir(), 'vajra-dial-'))
  try {
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({ version: 1, fetchedAt: Date.now(), catalog: parseCatalog(payload) }),
    )
    resetCatalog()
    await loadModelCatalog({
      env: { VAJRA_HOME: dir },
      now: Date.now(),
      fetchImpl: async () => {
        throw new Error('a primed catalog must not refetch')
      },
    })
    assert.equal(roleReasoningEffort('zen/gpt-5.4', 'xhigh'), 'xhigh')
    // The same dial, sent to the model that only has a toggle.
    assert.equal(roleReasoningEffort('zen/toggler', 'xhigh'), 'off')
    assert.equal(roleReasoningEffort('zen/gpt-5.4', undefined), 'off')
  } finally {
    resetCatalog()
    rmSync(dir, { recursive: true, force: true })
  }
})
