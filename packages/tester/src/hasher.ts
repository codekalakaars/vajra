// Filesystem-backed content hashing.
//
// The cache needs file contents, and a caller with no hasher gets no caching
// at all. Hashing here rather than in the verifier keeps node:fs out of the
// pure modules, so everything above this line stays testable with fakes.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ContentHasher } from './verifier.js'

/** Hash for a path that does not exist, distinct from a hash of empty content. */
const MISSING = 'missing'

export function createFsHasher(root: string): ContentHasher {
  const base = resolve(root)

  const toRepoPath = (file: string): string => {
    const full = isAbsolute(file) ? file : join(base, file)
    const rel = relative(base, full)
    return rel.startsWith('..') ? full : rel.split('\\').join('/')
  }

  return {
    async hashFile(file: string): Promise<string> {
      try {
        const content = await readFile(isAbsolute(file) ? file : join(base, file))
        return createHash('sha256').update(content).digest('hex')
      } catch {
        return MISSING
      }
    },
    async hashFiles(files: readonly string[]): Promise<string> {
      if (files.length === 0) return createHash('sha256').digest('hex')
      const parts = await Promise.all(
        [...files].sort().map(async (f) => `${toRepoPath(f)}:${await this.hashFile(f)}`),
      )
      return createHash('sha256').update(parts.join('\n')).digest('hex')
    },
  }
}
