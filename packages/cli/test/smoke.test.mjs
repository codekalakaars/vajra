import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

// The TUI starts in the directory saved from its Defaults screen; the CLI used
// to default --dir to process.cwd() and ignore that saved value entirely, so
// `vajra sessions` could report "No sessions recorded" while the TUI's Sessions
// menu showed the very same session. Keeping the two in agreement was left to
// the user, who has no reason to know either side exists.
test('sessions resolve the directory the TUI saved, so the two never disagree', async () => {
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

    // A shell sitting in a directory that is not the saved project:
    // the default lives in ~/.vajra/config.json (VAJRA_HOME redirects here).
    const home = mkdtempSync(join(tmpdir(), 'vajra-home-'))
    const { saveDefaults } = await import(
      pathToFileURL(join(import.meta.dirname, '..', 'dist', 'config.js')).href
    )
    saveDefaults({ projectDir: project }, { VAJRA_HOME: home })

    const { stdout } = await execFileAsync(process.execPath, [cliEntry, 'sessions'], {
      cwd: elsewhere,
      env: { ...process.env, VAJRA_HOME: home },
      timeout: 10000,
    })
    assert.match(stdout, /sess-from-the-tui/, 'must find the session without being told where')
    assert.doesNotMatch(stdout, /No sessions recorded/)

    // An explicit --dir still wins over the saved default.
    const other = mkdtempSync(join(tmpdir(), 'vajra-other-'))
    try {
      const explicit = await execFileAsync(
        process.execPath,
        [cliEntry, 'sessions', '--dir', other],
        { cwd: elsewhere, env: { ...process.env, VAJRA_HOME: home }, timeout: 10000 },
      )
      assert.match(explicit.stdout, new RegExp(`No sessions recorded for ${other}`))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
    rmSync(home, { recursive: true, force: true })
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  }
})
