import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SandboxDaemon } from '../dist/daemon.js'
import { SandboxClient } from '../dist/client.js'
import { createSandboxConfig, saveSandboxConfig } from '../dist/index.js'

// ---------------------------------------------------------------------------
// SandboxDaemon + SandboxClient integration
// ---------------------------------------------------------------------------

describe('SandboxDaemon + SandboxClient', () => {
  let tempDir
  let socketPath
  let daemon
  let client

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandbox-daemon-test-'))
    socketPath = join(tempDir, 'test.sock')
  })

  afterEach(async () => {
    if (client?.isConnected) await client.disconnect()
    if (daemon?.running) await daemon.stop()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('starts and stops cleanly', async () => {
    daemon = new SandboxDaemon({ projectDir: tempDir, socketPath })
    await daemon.start()
    assert.ok(daemon.running)

    await daemon.stop()
    assert.ok(!daemon.running)
  })

  it('client connects and pings', async () => {
    daemon = new SandboxDaemon({ projectDir: tempDir, socketPath })
    await daemon.start()

    client = new SandboxClient({ socketPath })
    await client.connect()
    assert.ok(client.isConnected)

    const alive = await client.ping()
    assert.ok(alive)
  })

  it('registers an agent', async () => {
    daemon = new SandboxDaemon({ projectDir: tempDir, socketPath })
    await daemon.start()

    client = new SandboxClient({ socketPath })
    await client.connect()

    const { id } = await client.register('test-agent', 12345)
    assert.ok(id)
    assert.ok(id.length > 0)

    const { agents } = await client.listAgents()
    assert.equal(agents.length, 1)
    assert.equal(agents[0].name, 'test-agent')
    assert.equal(agents[0].pid, 12345)
  })

  it('acquires and releases file locks', async () => {
    daemon = new SandboxDaemon({ projectDir: tempDir, socketPath })
    await daemon.start()

    client = new SandboxClient({ socketPath })
    await client.connect()

    const { id } = await client.register('test-agent')
    const { acquired } = await client.acquireLock(['src/index.ts'], id, 'write')
    assert.ok(acquired)

    const { locks } = await client.listLocks()
    assert.equal(locks.length, 1)
    assert.equal(locks[0].file, 'src/index.ts')
    assert.equal(locks[0].mode, 'write')

    await client.releaseLock(id)

    const { locks: locks2 } = await client.listLocks()
    assert.equal(locks2.length, 0)
  })

  it('checks file permissions', async () => {
    // Create a sandbox config that allows write to src/ but denies .env
    const config = createSandboxConfig({
      projectDir: tempDir,
      defaultPermissions: { read: true, write: true, edit: true, delete: false },
      fileRules: [{ pattern: '.env', write: false }],
    })
    saveSandboxConfig(tempDir, config)

    daemon = new SandboxDaemon({ projectDir: tempDir, socketPath })
    await daemon.start()

    client = new SandboxClient({ socketPath })
    await client.connect()

    // .env should be denied
    const { allowed: denied } = await client.checkPermission('.env', 'write')
    assert.equal(denied, false)

    // src/index.ts should be allowed (no rule, default allows write)
    const { allowed } = await client.checkPermission('src/index.ts', 'write')
    assert.ok(allowed)
  })

  it('returns daemon status', async () => {
    daemon = new SandboxDaemon({ projectDir: tempDir, socketPath })
    await daemon.start()

    client = new SandboxClient({ socketPath })
    await client.connect()

    const { status } = await client.getStatus()
    assert.ok(status.running)
    assert.equal(status.projectDir, tempDir)
    assert.equal(status.agents.length, 0)
    assert.equal(status.locks.length, 0)
  })

  it('cleans up agent on disconnect', async () => {
    daemon = new SandboxDaemon({ projectDir: tempDir, socketPath })
    await daemon.start()

    const client1 = new SandboxClient({ socketPath })
    await client1.connect()
    const { id } = await client1.register('disconnect-test')
    await client1.acquireLock(['file.txt'], id, 'write')

    // Verify agent and lock exist
    let { agents } = await client1.listAgents()
    assert.equal(agents.length, 1)
    let { locks } = await client1.listLocks()
    assert.equal(locks.length, 1)

    // Disconnect
    await client1.disconnect()

    // Give daemon time to process disconnect
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify cleanup
    const client2 = new SandboxClient({ socketPath })
    await client2.connect()
    const { agents: agents2 } = await client2.listAgents()
    assert.equal(agents2.length, 0)
    const { locks: locks2 } = await client2.listLocks()
    assert.equal(locks2.length, 0)
    await client2.disconnect()
  })
})
