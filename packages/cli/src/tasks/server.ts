import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

export const SERVER_REQUIRED_PATTERNS = [
  /\bnpm\s+test\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bvitest\b/,
  /\bcurl\s+.*localhost/,
  /\bcurl\s+.*127\.0\.0\.1/,
  /\bwget\s+.*localhost/,
  /\bwget\s+.*127\.0\.0\.1/,
  /\bapi[_-]?test/,
  /\bintegration[_-]?test/,
]

export function needsServer(validationCommands: string[]): boolean {
  return validationCommands.some(cmd =>
    SERVER_REQUIRED_PATTERNS.some(pattern => pattern.test(cmd))
  )
}

export async function findServerEntry(projectDir: string): Promise<string | null> {
  const candidates = ['src/index.js', 'src/server.js', 'src/app.js', 'index.js', 'server.js', 'app.js']
  for (const candidate of candidates) {
    const fullPath = resolve(projectDir, candidate)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      continue
    }
  }
  return null
}
