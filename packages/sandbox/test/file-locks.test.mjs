import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FileLockManager } from '../dist/file-locks.js'

describe('FileLockManager', () => {
  describe('canAcquire', () => {
    it('allows read when no locks exist', () => {
      const locks = new FileLockManager()
      assert.equal(locks.canAcquire(['src/index.ts'], 'read'), true)
    })

    it('allows write when no locks exist', () => {
      const locks = new FileLockManager()
      assert.equal(locks.canAcquire(['src/index.ts'], 'write'), true)
    })

    it('allows multiple reads on same file', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'read')
      assert.equal(locks.canAcquire(['src/index.ts'], 'read'), true)
    })

    it('blocks write when read lock exists', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'read')
      assert.equal(locks.canAcquire(['src/index.ts'], 'write'), false)
    })

    it('blocks read when write lock exists', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'write')
      assert.equal(locks.canAcquire(['src/index.ts'], 'read'), false)
    })

    it('blocks write when write lock exists', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'write')
      assert.equal(locks.canAcquire(['src/index.ts'], 'write'), false)
    })

    it('allows read on different file when write lock exists', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'write')
      assert.equal(locks.canAcquire(['src/utils.ts'], 'read'), true)
    })
  })

  describe('tryAcquire', () => {
    it('acquires read lock', () => {
      const locks = new FileLockManager()
      assert.equal(locks.tryAcquire(['src/index.ts'], 'task1', 'read'), true)
    })

    it('acquires write lock', () => {
      const locks = new FileLockManager()
      assert.equal(locks.tryAcquire(['src/index.ts'], 'task1', 'write'), true)
    })

    it('fails to acquire write when read exists', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'read')
      assert.equal(locks.tryAcquire(['src/index.ts'], 'task2', 'write'), false)
    })

    it('acquires multiple file locks', () => {
      const locks = new FileLockManager()
      assert.equal(locks.tryAcquire(['src/index.ts', 'src/utils.ts'], 'task1', 'write'), true)
    })
  })

  describe('release', () => {
    it('releases all locks held by owner', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'write')
      locks.release('task1')
      assert.equal(locks.canAcquire(['src/index.ts'], 'write'), true)
    })

    it('does not release locks held by other owners', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'read')
      locks.tryAcquire(['src/utils.ts'], 'task2', 'read')
      locks.release('task1')
      assert.equal(locks.canAcquire(['src/index.ts'], 'read'), true)
      assert.equal(locks.canAcquire(['src/utils.ts'], 'read'), true)
    })
  })

  describe('releaseFiles', () => {
    it('releases specific files', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts', 'src/utils.ts'], 'task1', 'write')
      locks.releaseFiles(['src/index.ts'], 'task1')
      assert.equal(locks.canAcquire(['src/index.ts'], 'write'), true)
      assert.equal(locks.canAcquire(['src/utils.ts'], 'write'), false)
    })
  })

  describe('getOwners', () => {
    it('returns empty array for unlocked file', () => {
      const locks = new FileLockManager()
      assert.deepEqual(locks.getOwners('src/index.ts'), [])
    })

    it('returns owners of locked file', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'read')
      locks.tryAcquire(['src/index.ts'], 'task2', 'read')
      assert.deepEqual(locks.getOwners('src/index.ts'), ['task1', 'task2'])
    })
  })

  describe('hasLocks', () => {
    it('returns false for owner with no locks', () => {
      const locks = new FileLockManager()
      assert.equal(locks.hasLocks('task1'), false)
    })

    it('returns true for owner with locks', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'read')
      assert.equal(locks.hasLocks('task1'), true)
    })
  })

  describe('getLocks', () => {
    it('returns current lock state', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'read')
      const state = locks.getLocks()
      assert.equal(state.has('src/index.ts'), true)
      assert.equal(state.get('src/index.ts')?.length, 1)
    })
  })

  describe('acquireOrWait', () => {
    it('acquires immediately when available', async () => {
      const locks = new FileLockManager()
      await locks.acquireOrWait(['src/index.ts'], 'task1', 'write')
      assert.equal(locks.hasLocks('task1'), true)
    })

    it('waits until lock becomes available', async () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'write')

      let acquired = false
      const waiter = locks.acquireOrWait(['src/index.ts'], 'task2', 'write').then(() => {
        acquired = true
      })

      // Not yet acquired
      await new Promise(r => setTimeout(r, 10))
      assert.equal(acquired, false)

      // Release the lock
      locks.release('task1')
      await waiter
      assert.equal(acquired, true)
      assert.equal(locks.hasLocks('task2'), true)
    })
  })

  describe('drain', () => {
    it('clears all locks', () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'write')
      locks.tryAcquire(['src/utils.ts'], 'task2', 'read')
      locks.drain()
      assert.equal(locks.canAcquire(['src/index.ts'], 'write'), true)
      assert.equal(locks.canAcquire(['src/utils.ts'], 'read'), true)
    })

    it('resolves pending waiters', async () => {
      const locks = new FileLockManager()
      locks.tryAcquire(['src/index.ts'], 'task1', 'write')

      let resolved = false
      locks.acquireOrWait(['src/index.ts'], 'task2', 'write').then(() => {
        resolved = true
      })

      await new Promise(r => setTimeout(r, 10))
      assert.equal(resolved, false)

      locks.drain()
      await new Promise(r => setTimeout(r, 10))
      assert.equal(resolved, true)
    })
  })
})
