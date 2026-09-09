import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { matchesPattern } from '../dist/file-rules.js'
import { createSandboxConfig } from '../dist/config.js'
import { resolveAllowedTools } from '../dist/tool-rules.js'
import { buildLaunchJob } from '../dist/sandbox-builder.js'
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
    assert.equal(config.allowedTools, null)
    assert.equal(config.allowUnenforced, false)
  })

  it('creates a config with custom values', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      allowedTools: ['read_file', 'write_file'],
      fileRules: [{ pattern: 'src/**', read: true, write: true }],
      allowUnenforced: true,
    })
    assert.deepEqual([...config.allowedTools], ['read_file', 'write_file'])
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
// resolveAllowedTools
// ---------------------------------------------------------------------------

describe('resolveAllowedTools', () => {
  it('returns all tools when no restriction is set', () => {
    const config = createSandboxConfig({ projectDir: '/test' })
    const tools = resolveAllowedTools(config)
    assert.ok(tools.length > 0)
    assert.ok(tools.includes('read_file'))
    assert.ok(tools.includes('write_file'))
  })

  it('filters to explicit allowlist', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      allowedTools: ['read_file', 'list_files'],
    })
    const tools = resolveAllowedTools(config)
    assert.deepEqual(tools, ['read_file', 'list_files'])
  })

  it('drops unknown tool names', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      allowedTools: ['read_file', 'nonexistent_tool'],
    })
    const tools = resolveAllowedTools(config)
    assert.deepEqual(tools, ['read_file'])
  })

  it('filters by role defaults', () => {
    const config = createSandboxConfig({ projectDir: '/test' })
    const tools = resolveAllowedTools(config, 'worker')
    assert.ok(tools.includes('read_file'))
    assert.ok(tools.includes('write_file'))
    assert.ok(tools.includes('edit_file'))
  })
})

// ---------------------------------------------------------------------------
// buildLaunchJob
// ---------------------------------------------------------------------------

describe('buildLaunchJob', () => {
  it('produces a LaunchJob from a config', () => {
    const config = createSandboxConfig({
      projectDir: '/test',
      allowedTools: ['read_file'],
    })
    const job = buildLaunchJob(config, 'session-1')
    assert.equal(job.sessionId, 'session-1')
    assert.equal(job.projectDir, '/test')
    assert.deepEqual(job.allowedTools, ['read_file'])
    assert.equal(job.permissions.version, 1)
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
      allowedTools: ['read_file', 'write_file'],
      fileRules: [{ pattern: 'src/**', read: true, write: true }],
    })

    saveSandboxConfig(tempDir, config)
    const loaded = loadSandboxConfig(tempDir)

    assert.ok(loaded)
    assert.equal(loaded.version, 1)
    assert.deepEqual([...loaded.allowedTools], ['read_file', 'write_file'])
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
      allowedTools: ['read_file', 'list_files'],
    })
    const editor = createSandboxConfig({
      projectDir: tempDir,
      allowedTools: ['read_file', 'list_files', 'write_file', 'edit_file'],
    })

    saveSandboxEnvironments(tempDir, { reader, editor })

    const all = loadSandboxEnvironments(tempDir)
    assert.deepEqual(Object.keys(all).sort(), ['editor', 'reader'])
    assert.deepEqual([...all['reader'].allowedTools], ['read_file', 'list_files'])
    assert.deepEqual([...all['editor'].allowedTools], ['read_file', 'list_files', 'write_file', 'edit_file'])
  })

  it('loads a specific environment by name', () => {
    const loaded = loadSandboxConfig(tempDir, 'editor')
    assert.ok(loaded)
    assert.deepEqual([...loaded.allowedTools], ['read_file', 'list_files', 'write_file', 'edit_file'])
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
