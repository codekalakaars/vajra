import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { matchesPattern, resolveFilePermission, resolveFilePermissions, filterFileEntries } from '../dist/file-rules.js'
import { createSandboxConfig } from '../dist/config.js'
import {
  loadSandboxConfig,
  loadSandboxEnvironments,
  saveSandboxConfig,
  saveSandboxEnvironments,
} from '../dist/file-config.js'

// ---------------------------------------------------------------------------
// matchesPattern
// ---------------------------------------------------------------------------

describe('matchesPattern', () => {
  it('matches exact filenames', () => {
    assert.ok(matchesPattern('package.json', 'package.json'))
    assert.ok(!matchesPattern('src/index.ts', 'package.json'))
  })

  it('matches * against path segments', () => {
    assert.ok(matchesPattern('src/index.ts', 'src/*.ts'))
    assert.ok(matchesPattern('src/app.ts', 'src/*.ts'))
    assert.ok(!matchesPattern('src/utils/format.ts', 'src/*.ts'))
  })

  it('matches ** across directories', () => {
    assert.ok(matchesPattern('src/index.ts', 'src/**'))
    assert.ok(matchesPattern('src/utils/format.ts', 'src/**'))
    assert.ok(matchesPattern('src/a/b/c/d.ts', 'src/**'))
    assert.ok(!matchesPattern('lib/index.ts', 'src/**'))
  })

  it('matches ? for single character', () => {
    assert.ok(matchesPattern('file1.ts', 'file?.ts'))
    assert.ok(matchesPattern('fileA.ts', 'file?.ts'))
    assert.ok(!matchesPattern('file12.ts', 'file?.ts'))
  })

  it('negates with ! prefix', () => {
    assert.ok(!matchesPattern('.env', '!.env'))
    assert.ok(matchesPattern('src/index.ts', '!.env'))
  })

  it('handles top-level patterns without /', () => {
    assert.ok(matchesPattern('here.ts', '*.ts'))
    assert.ok(matchesPattern('deep/nested/file.ts', '**/*.ts'))
    assert.ok(!matchesPattern('anything/here.ts', '*.ts'))
  })

  it('handles complex patterns', () => {
    assert.ok(matchesPattern('src/components/Button.tsx', 'src/**/*.tsx'))
    assert.ok(!matchesPattern('lib/utils.ts', 'src/**/*.tsx'))
  })
})

// ---------------------------------------------------------------------------
// createSandboxConfig
// ---------------------------------------------------------------------------

describe('createSandboxConfig', () => {
  it('creates a config with defaults', () => {
    const config = createSandboxConfig({ projectDir: '/test' })
    assert.equal(config.version, 1)
    assert.equal(config.projectDir, '/test')
    assert.ok(config.defaultPermissions.read)
    assert.equal(config.defaultPermissions.write, false)
    assert.equal(config.fileRules.length, 0)
    assert.equal(config.allowUnenforced, false)
  })

  it('creates a config with custom values', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      fileRules: [{ pattern: 'src/**', read: true, write: true }],
      allowUnenforced: true,
    })
    assert.equal(config.fileRules.length, 1)
    assert.ok(config.allowUnenforced)
  })

  it('freezes the config', () => {
    const config = createSandboxConfig({ projectDir: '/test' })
    assert.throws(() => {
      config.projectDir = '/other'
    })
  })
})

// ---------------------------------------------------------------------------
// File config persistence
// ---------------------------------------------------------------------------

describe('file config persistence', () => {
  let tempDir

  it('setup', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandbox-test-'))
  })

  it('saves and loads a flat config', () => {
    const config = createSandboxConfig({
      projectDir: tempDir,
      fileRules: [{ pattern: 'src/**', read: true, write: true }],
    })

    saveSandboxConfig(tempDir, config)
    const loaded = loadSandboxConfig(tempDir)

    assert.ok(loaded)
    assert.equal(loaded.version, 1)
    assert.equal(loaded.fileRules.length, 1)
  })

  it('returns null for missing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-empty-'))
    const loaded = loadSandboxConfig(dir)
    assert.equal(loaded, null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves and loads named environments', () => {
    const reader = createSandboxConfig({
      projectDir: tempDir,
    })
    const editor = createSandboxConfig({
      projectDir: tempDir,
    })

    saveSandboxEnvironments(tempDir, { reader, editor })

    const all = loadSandboxEnvironments(tempDir)
    assert.deepEqual(Object.keys(all).sort(), ['editor', 'reader'])
  })

  it('loads a specific environment by name', () => {
    const loaded = loadSandboxConfig(tempDir, 'editor')
    assert.ok(loaded)
  })

  it('returns null for unknown environment name', () => {
    const loaded = loadSandboxConfig(tempDir, 'nonexistent')
    assert.equal(loaded, null)
  })

  it('handles corrupted JSON gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-corrupt-'))
    writeFileSync(join(dir, '.vajra-sandbox.json'), '{not json')
    const loaded = loadSandboxConfig(dir)
    assert.equal(loaded, null)
    const envs = loadSandboxEnvironments(dir)
    assert.deepEqual(envs, {})
    rmSync(dir, { recursive: true, force: true })
  })

  it('cleanup', () => {
    rmSync(tempDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// resolveFilePermission
// ---------------------------------------------------------------------------

describe('resolveFilePermission', () => {
  it('returns default permissions when no rules match', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      defaultPermissions: { read: true, write: false, edit: false, delete: false },
    })
    const perm = resolveFilePermission(config, 'src/index.ts')
    assert.deepEqual(perm, { read: true, write: false, edit: false, delete: false })
  })

  it('applies matching rules in order', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      defaultPermissions: { read: true, write: false, edit: false, delete: false },
      fileRules: [
        { pattern: 'src/**', write: true },
        { pattern: 'src/secret.ts', write: false },
      ],
    })
    // src/index.ts matches first rule only
    const perm1 = resolveFilePermission(config, 'src/index.ts')
    assert.equal(perm1.write, true)

    // src/secret.ts matches both rules; second overrides
    const perm2 = resolveFilePermission(config, 'src/secret.ts')
    assert.equal(perm2.write, false)
  })

  it('handles negation patterns', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      defaultPermissions: { read: true, write: true, edit: true, delete: false },
      fileRules: [
        { pattern: '!.env', write: false },
      ],
    })
    // .env does NOT match !.env (negated), so default write=true applies
    const perm1 = resolveFilePermission(config, '.env')
    assert.equal(perm1.write, true)

    // src/index.ts matches !.env (it's not .env), so write=false
    const perm2 = resolveFilePermission(config, 'src/index.ts')
    assert.equal(perm2.write, false)
  })
})

// ---------------------------------------------------------------------------
// resolveFilePermissions
// ---------------------------------------------------------------------------

describe('resolveFilePermissions', () => {
  it('returns PermissionsConfig with default permissions', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      defaultPermissions: { read: true, write: false, edit: false, delete: false },
    })
    const result = resolveFilePermissions(config)
    assert.equal(result.version, 1)
    assert.deepEqual(result.default, { read: true, write: false, edit: false, delete: false })
    assert.deepEqual(result.files, {})
  })
})

// ---------------------------------------------------------------------------
// filterFileEntries
// ---------------------------------------------------------------------------

describe('filterFileEntries', () => {
  it('includes directories always', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      defaultPermissions: { read: false, write: false, edit: false, delete: false },
    })
    const entries = [
      { name: 'src', path: 'src', isDir: true, isMasked: false },
      { name: 'index.ts', path: 'src/index.ts', isDir: false, isMasked: false },
    ]
    const filtered = filterFileEntries(entries, config)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].name, 'src')
  })

  it('filters files by read permission', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      defaultPermissions: { read: true, write: false, edit: false, delete: false },
      fileRules: [
        { pattern: '.env', read: false },
      ],
    })
    const entries = [
      { name: 'index.ts', path: 'src/index.ts', isDir: false, isMasked: false },
      { name: '.env', path: '.env', isDir: false, isMasked: false },
      { name: 'config.ts', path: 'src/config.ts', isDir: false, isMasked: false },
    ]
    const filtered = filterFileEntries(entries, config)
    assert.equal(filtered.length, 2)
    assert.ok(filtered.every(e => e.path !== '.env'))
  })
})

