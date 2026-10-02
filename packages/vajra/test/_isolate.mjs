import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach } from 'node:test'

/**
 * Point VAJRA_HOME at a fresh temp dir for this test process. Sessions,
 * config and auth all resolve there, so suites never read or write the real
 * ~/.vajra and parallel test files never race each other's store.
 * Call once at the top of a test file; cleaned up on process exit.
 */
export function useTempVajraHome(prefix = 'vajra-home-') {
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.VAJRA_HOME = home
  process.on('exit', () => {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // Best effort — the OS reclaims /tmp anyway.
    }
  })
  return home
}

/**
 * Fresh VAJRA_HOME per test (node:test hooks), for suites whose tests reuse
 * session ids: without this, message rows from one test leak into the next.
 */
export function isolateEachTest(prefix = 'vajra-home-') {
  let home
  let previous
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), prefix))
    previous = process.env.VAJRA_HOME
    process.env.VAJRA_HOME = home
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.VAJRA_HOME
    else process.env.VAJRA_HOME = previous
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  })
}
