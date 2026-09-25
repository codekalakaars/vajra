import { access } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
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

const recentPorts = new Set<number>()

function probeFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    const onError = (error: Error) => {
      server.close()
      reject(error)
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a validation-server port')))
        return
      }
      server.close(error => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

export async function allocateServerPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = await probeFreePort()
    if (recentPorts.has(port)) continue
    recentPorts.add(port)
    if (recentPorts.size > 128) {
      const oldest = recentPorts.values().next().value
      if (oldest !== undefined) recentPorts.delete(oldest)
    }
    return port
  }
  throw new Error('Could not find an unused validation-server port')
}

export function probeServerPort(port: number, timeoutMs = 100): Promise<boolean> {
  const hosts = ['127.0.0.1', '::1']
  const probe = (host: string): Promise<boolean> => new Promise(resolve => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
  return probe(hosts[0]).then(first => first ? true : probe(hosts[1]))
}

export function substituteServerPort(command: string, port: number): string {
  const value = String(port)
  return command
    .replace(/\$\{PORT\}|\$PORT\b|\{\{PORT\}\}|<PORT>/g, value)
    .replace(/process\.env\.PORT\b/g, value)
    .replace(/\b(localhost|127\.0\.0\.1):\d+\b/g, `$1:${value}`)
    .replace(/\b(localhost|127\.0\.0\.1)(?=\/|$)/g, `$1:${value}`)
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
