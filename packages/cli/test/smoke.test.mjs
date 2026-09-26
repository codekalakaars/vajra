import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { useTempVajraHome } from './_isolate.mjs'

useTempVajraHome('vajra-smoke-')

const execFileAsync = promisify(execFile)
const cliEntry = join(import.meta.dirname, '..', 'dist', 'index.js')

test('CLI package builds an entrypoint', () => {
  assert.ok(existsSync(cliEntry), `missing ${cliEntry}`)
})

test('vajra --version reports 0.0.1', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, '--version'], {
    timeout: 10000,
  })
  assert.match(stdout.trim(), /^0\.0\.1$/)
})

test('vajra --help lists core commands', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, '--help'], {
    timeout: 10000,
  })
  assert.match(stdout, /run/)
  assert.match(stdout, /config/)
})

test('vajra run --help documents explicit unenforced opt-in', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, 'run', '--help'], {
    timeout: 10000,
  })
  assert.match(stdout, /--allow-unenforced/)
})

test('parseProposePlanArgs-style plan shape is reachable via protocol schemas', async () => {
  const protocolUrl = pathToFileURL(
    join(import.meta.dirname, '..', '..', 'protocol', 'dist', 'index.js'),
  ).href
  const { toolDefinitions } = await import(protocolUrl)

  const parsed = toolDefinitions.propose_plan.schema.parse({
    tasks: [{ id: 't1', title: 't', description: 'd' }],
    summary: 's',
  })
  assert.equal(parsed.tasks[0].id, 't1')
  assert.equal(parsed.tasks[0].type, 'modify')
  assert.deepEqual(parsed.tasks[0].instructions, [])
})

// Sessions live in one store under VAJRA_HOME, so the CLI finds them from any
// directory: no per-project discovery, no saved-dir agreement left to the
// user. `--dir` narrows when a project view is wanted.
test('sessions list every project from any directory; --dir narrows', async () => {
  const project = mkdtempSync(join(tmpdir(), 'vajra-proj-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'vajra-cwd-'))
  try {
    const { saveSession, SESSION_SCHEMA_VERSION } = await import(
      pathToFileURL(join(import.meta.dirname, '..', 'dist', 'persist', 'index.js')).href
    )
    saveSession({
      version: SESSION_SCHEMA_VERSION,
      sessionId: 'sess-from-the-tui',
      projectDir: project,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { model: 'zen/space-bunny-free', timeoutSeconds: 300 },
      phase: 'finished',
      plan: null,
      evidence: null,
      tasks: {},
      fileHashes: {},
      summaryFingerprint: null,
    })

    const { stdout } = await execFileAsync(process.execPath, [cliEntry, 'sessions'], {
      cwd: elsewhere,
      timeout: 10000,
    })
    assert.match(stdout, /sess-from-the-tui/, 'must find the session without being told where')
    assert.match(stdout, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'shows which project it belongs to')
    assert.doesNotMatch(stdout, /No sessions recorded/)

    // An explicit --dir still narrows to one project.
    const other = mkdtempSync(join(tmpdir(), 'vajra-other-'))
    try {
      const explicit = await execFileAsync(
        process.execPath,
        [cliEntry, 'sessions', '--dir', other],
        { cwd: elsewhere, timeout: 10000 },
      )
      assert.match(explicit.stdout, new RegExp(`No sessions recorded for ${other}`))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  }
})
