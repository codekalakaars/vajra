// Defaults persisted by the TUI's Defaults screen must survive a restart:
// saveDefaults writes ~/.vajra/config.json (VAJRA_HOME redirects in tests).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const {
  DEFAULT_DIR_KEY,
  DEFAULT_MODEL_KEY,
  isPersistedDefault,
  readConfig,
  resolveDefaultDir,
  resolveDefaultModel,
  saveDefaults,
} = await import(pathToFileURL(join(repoRoot, 'packages/cli/dist/config.js')).href)

/** Each case gets its own VAJRA_HOME so configs never leak between tests. */
function inHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'vajra-home-'))
  const env = { ...process.env, VAJRA_HOME: home }
  try {
    return fn(home, env)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('TUI defaults', () => {
  test('a saved model and directory survive a reload', () => {
    inHome((home, env) => {
      const path = saveDefaults({ model: 'zen/big-pickle', projectDir: home }, env)
      assert.equal(path, join(home, 'config.json'))

      assert.equal(resolveDefaultModel(env), 'zen/big-pickle')
      assert.equal(resolveDefaultDir(env), home)
      assert.deepEqual(readConfig(env), { model: 'zen/big-pickle', projectDir: home })
    })
  })

  test('saving one default leaves the other untouched', () => {
    inHome((_home, env) => {
      saveDefaults({ model: 'zen/mimo-v2.5-free', projectDir: '/tmp/somewhere' }, env)
      saveDefaults({ model: 'zen/jev-1.13-free' }, env)

      assert.equal(resolveDefaultModel(env), 'zen/jev-1.13-free')
      assert.equal(readConfig(env).projectDir, '/tmp/somewhere', 'directory must not be cleared')
    })
  })

  test('an unsupported model id is rejected rather than persisted', () => {
    inHome((_home, env) => {
      saveDefaults({ model: 'zen/big-pickle' }, env)
      assert.throws(() => saveDefaults({ model: 'not a model' }, env), /Invalid model id/)
      assert.equal(resolveDefaultModel(env), 'zen/big-pickle')
    })
  })

  test('isPersistedDefault distinguishes a saved value from the built-in fallback', () => {
    inHome((_home, env) => {
      assert.equal(isPersistedDefault(DEFAULT_MODEL_KEY, env), false)

      saveDefaults({ model: 'zen/space-bunny-free' }, env)
      assert.equal(isPersistedDefault(DEFAULT_MODEL_KEY, env), true)
      assert.equal(isPersistedDefault(DEFAULT_DIR_KEY, env), false)
    })
  })

  test('exported env vars beat config.json; config beats the builtin', () => {
    inHome((_home, env) => {
      assert.equal(resolveDefaultModel({ ...env }), 'zen/space-bunny-free')
      assert.equal(resolveDefaultDir({ ...env }), process.cwd())

      saveDefaults({ model: 'zen/big-pickle', projectDir: '/tmp/configured' }, env)
      assert.equal(resolveDefaultModel({ ...env, VAJRA_MODEL: 'zen/jev-1.13-free' }), 'zen/jev-1.13-free')
      assert.equal(resolveDefaultDir({ ...env, VAJRA_PROJECT_DIR: '/tmp/from-env' }), '/tmp/from-env')
    })
  })

  test('config.json contains only config keys — no secrets', () => {
    inHome((_home, env) => {
      saveDefaults({ model: 'zen/big-pickle' }, env)
      const raw = JSON.parse(readFileSync(join(env.VAJRA_HOME, 'config.json'), 'utf-8'))
      assert.deepEqual(Object.keys(raw).sort(), ['model'])
    })
  })
})
