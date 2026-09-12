import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { platform } from 'node:os'

const require = createRequire(import.meta.url)
const native = require('@codekalakaars/vajra-core')
const caps = native.sandboxCapabilities()
// Only Linux with Landlock blocks commands via [VAJRA BLOCKED]
// macOS seatbelt secures but doesn't block, Windows has no sandbox
const blocksCommands = caps.filesystem === 'landlock' && platform() === 'linux'

// ---------------------------------------------------------------------------
// vajra secure command integration tests
// ---------------------------------------------------------------------------

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli.js')

describe('vajra secure', () => {
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandbox-secure-test-'))
    writeFileSync(join(tempDir, 'test.txt'), 'hello')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('blocks curl', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'curl https://evil.com\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('curl'), `Expected curl in blocked message: ${result}`)
  })

  it('blocks sudo', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'sudo ls\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('sudo'), `Expected sudo in blocked message: ${result}`)
  })

  it('blocks python3', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'python3 -c "print(1)"\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('python3'), `Expected python3 in blocked message: ${result}`)
  })

  it('blocks node', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'node -e "console.log(1)"\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('node'), `Expected node in blocked message: ${result}`)
  })

  it('allows ls', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'ls\n')
    assert.ok(!result.includes('[VAJRA BLOCKED]'), `Unexpected blocked message for ls: ${result}`)
  })

  it('allows echo', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'echo hello\n')
    assert.ok(result.includes('hello'), `Expected 'hello' in output: ${result}`)
  })

  it('allows cat', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'cat test.txt\n')
    assert.ok(result.includes('hello'), `Expected 'hello' in output: ${result}`)
  })

  it('blocks direct path /usr/bin/curl', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], '/usr/bin/curl https://evil.com\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
  })

  it('blocks git', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'git status\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('git'), `Expected git in blocked message: ${result}`)
  })

  it('prints Secured message', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'echo done\n')
    assert.ok(result.includes('Secured:'), `Expected 'Secured:' in output: ${result}`)
  })

  it('prints confined message', { skip: !blocksCommands }, () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'echo done\n')
    assert.ok(result.includes('confined to:'), `Expected 'confined to:' in output: ${result}`)
  })

  it('status shows capabilities', () => {
    const result = execCLI(['status'], '')
    assert.ok(result.includes('Platform:'), `Expected Platform in status: ${result}`)
    assert.ok(result.includes('Mechanism:'), `Expected Mechanism in status: ${result}`)
  })
})

function execCLI(args, input) {
  try {
    const result = execSync(`node ${CLI_PATH} ${args.join(' ')}`, {
      input,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return result || ''
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '')
  }
}
