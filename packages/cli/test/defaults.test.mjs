// Defaults persisted by the TUI's Defaults screen must survive a restart:
// saveDefaults writes to the same .env the CLI reads at startup.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const {
  DEFAULT_DIR_KEY,
  DEFAULT_MODEL_KEY,
  isPersistedDefault,
  readEnvFile,
  resolveDefaultDir,
  resolveDefaultModel,
  saveDefaults,
} = await import(pathToFileURL(join(repoRoot, 'packages/cli/dist/env.js')).href)

/** saveDefaults/findEnvPath resolve against cwd, so each case gets its own. */
function inScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-defaults-'))
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    writeFileSync(join(dir, '.env'), '')
    return fn(dir)
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('TUI defaults', () => {
  test('a saved model and directory survive a reload', () => {
    inScratch((dir) => {
      const envPath = saveDefaults({ model: 'zen/big-pickle', projectDir: dir })

      const reloaded = readEnvFile(envPath)
      assert.equal(resolveDefaultModel(reloaded), 'zen/big-pickle')
      assert.equal(resolveDefaultDir(reloaded), dir)
    })
  })

  test('saving one default leaves the other untouched', () => {
    inScratch((dir) => {
      saveDefaults({ model: 'zen/mimo-v2.5-free', projectDir: dir })
      const envPath = saveDefaults({ model: 'zen/jev-1.13-free' })

      const reloaded = readEnvFile(envPath)
      assert.equal(resolveDefaultModel(reloaded), 'zen/jev-1.13-free')
      assert.equal(resolveDefaultDir(reloaded), dir, 'directory must not be cleared')
    })
  })

  test('an unsupported model id is rejected rather than persisted', () => {
    inScratch((dir) => {
      assert.throws(() => saveDefaults({ model: 'not a model' }), /Invalid model id/)
      assert.equal(readEnvFile(join(dir, '.env'))[DEFAULT_MODEL_KEY], undefined)
    })
  })

  test('isPersistedDefault distinguishes a saved value from the built-in fallback', () => {
    inScratch((dir) => {
      const envPath = join(dir, '.env')
      assert.equal(isPersistedDefault(DEFAULT_MODEL_KEY, envPath), false)

      saveDefaults({ model: 'zen/space-bunny-free' })
      assert.equal(isPersistedDefault(DEFAULT_MODEL_KEY, envPath), true)
      assert.equal(isPersistedDefault(DEFAULT_DIR_KEY, envPath), false)
    })
  })

  test('other .env keys are preserved', () => {
    inScratch((dir) => {
      const envPath = join(dir, '.env')
      writeFileSync(envPath, 'OPENCODE_API_KEY=sk-test-123\n')

      saveDefaults({ model: 'zen/big-pickle' })

      const contents = readFileSync(envPath, 'utf-8')
      assert.match(contents, /OPENCODE_API_KEY=sk-test-123/)
      assert.match(contents, /VAJRA_MODEL=zen\/big-pickle/)
    })
  })
})
