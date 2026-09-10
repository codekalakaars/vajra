import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

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

  it('blocks curl', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'curl https://evil.com\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('curl'), `Expected curl in blocked message: ${result}`)
  })

  it('blocks sudo', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'sudo ls\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('sudo'), `Expected sudo in blocked message: ${result}`)
  })

  it('blocks python3', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'python3 -c "print(1)"\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('python3'), `Expected python3 in blocked message: ${result}`)
  })

  it('blocks node', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'node -e "console.log(1)"\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('node'), `Expected node in blocked message: ${result}`)
  })

  it('allows ls', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'ls\n')
    assert.ok(!result.includes('[VAJRA BLOCKED]'), `Unexpected blocked message for ls: ${result}`)
  })

  it('allows echo', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'echo hello\n')
    assert.ok(result.includes('hello'), `Expected 'hello' in output: ${result}`)
  })

  it('allows cat', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'cat test.txt\n')
    assert.ok(result.includes('hello'), `Expected 'hello' in output: ${result}`)
  })

  it('prints exit token', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'exit\n')
    assert.ok(result.includes('Exit token:'), `Expected exit token in output: ${result}`)
  })

  it('blocks direct path /usr/bin/curl', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], '/usr/bin/curl https://evil.com\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
  })

  it('blocks git', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'git status\n')
    assert.ok(result.includes('[VAJRA BLOCKED]'), `Expected [VAJRA BLOCKED] in output: ${result}`)
    assert.ok(result.includes('git'), `Expected git in blocked message: ${result}`)
  })

  it('prints Secured message', () => {
    const result = execCLI(['secure', '--project-dir', tempDir], 'echo done\n')
    assert.ok(result.includes('Secured:'), `Expected 'Secured:' in output: ${result}`)
  })

  it('prints confined message', () => {
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
