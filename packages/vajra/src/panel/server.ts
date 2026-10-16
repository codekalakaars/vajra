import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { loadProjectPolicy, PolicyFileError } from '../guard/project-policy.js'
import { renderPage } from './page.js'
import { cleanRelative, listFolder, policyProblem, policyText, RightsError, saveRights, type Rights } from './rights.js'

/**
 * The control page's server. It listens on loopback only, and every API call needs a random token that
 * only the browser Vajra opened is given. The shell shares the machine's network, so it can reach this
 * port; the token, the Host check and the Origin check are what stop it from changing its own rules.
 */

export interface PanelOptions {
  projectRoot: string
  /** The policy text the running shell was started from, to tell whether the file has changed since. */
  appliedPolicy: () => string
  /** The agent that would be resumed by a restart, or null. */
  agent: () => string | null
  /** Called when the person asks to apply the rules. */
  onApply: () => void
}

export interface Panel {
  port: number
  token: string
  /** Where to send the browser: the token is in the fragment, which the browser never sends over HTTP. */
  browserUrl: string
  close: () => Promise<void>
}

const MAX_BODY = 8 * 1024

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers,
  })
  res.end(text)
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return reject(new RightsError('the request must be JSON'))
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        // Keep reading and throw the rest away, so the reply can still be sent instead of the connection dropping.
        if (size - chunk.length <= MAX_BODY) reject(new RightsError('the request is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
        resolve(value as Record<string, unknown>)
      } catch {
        reject(new RightsError('the request is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function flag(body: Record<string, unknown>, name: string): boolean {
  if (typeof body[name] !== 'boolean') throw new RightsError(`"${name}" must be true or false`)
  return body[name] as boolean
}

export async function startPanel(options: PanelOptions): Promise<Panel> {
  const token = randomBytes(32).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)
  let port = 0

  const sameOrigin = (req: IncomingMessage): boolean => {
    if (req.headers.host !== `127.0.0.1:${port}`) return false
    const origin = req.headers.origin
    return origin === undefined || origin === `http://127.0.0.1:${port}`
  }
  const hasToken = (req: IncomingMessage): boolean => {
    const given = Buffer.from(req.headers.authorization ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!sameOrigin(req)) return send(res, 403, { error: 'wrong host or origin' })
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    if (req.method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64')
      return send(res, 200, renderPage(nonce), {
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })
    if (!hasToken(req)) return send(res, 401, { error: 'missing or wrong token' })

    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const problem = policyProblem(options.projectRoot)
        return send(res, 200, { project: options.projectRoot, pending: policyText(options.projectRoot) !== options.appliedPolicy(), agent: options.agent(), problem })
      }
      if (req.method === 'GET' && url.pathname === '/api/list') {
        const rel = cleanRelative(url.searchParams.get('path') ?? '')
        const loaded = loadProjectPolicy(options.projectRoot)
        return send(res, 200, { entries: listFolder(options.projectRoot, rel, loaded.config, new Set(loaded.create)), create: rel === '' ? loaded.create.includes('') : undefined, read: rel === '' ? loaded.config.default.read : undefined })
      }
      if (req.method === 'POST' && url.pathname === '/api/rights') {
        const body = await readJson(req)
        const rights: Rights = { read: flag(body, 'read'), write: flag(body, 'write'), delete: flag(body, 'delete'), create: body.create === undefined ? false : flag(body, 'create') }
        saveRights(options.projectRoot, body.path, flag(body, 'isDir'), rights)
        return send(res, 200, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/api/apply') {
        await readJson(req)
        const problem = policyProblem(options.projectRoot)
        if (problem !== null) return send(res, 409, { error: `the rules cannot be used, so the shell was not restarted: ${problem}` })
        send(res, 202, { ok: true })
        options.onApply()
        return
      }
      return send(res, 404, { error: 'not found' })
    } catch (error) {
      if (error instanceof RightsError || error instanceof PolicyFileError) return send(res, 400, { error: error.message })
      return send(res, 500, { error: 'internal error' })
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  port = (server.address() as { port: number }).port
  return {
    port,
    token,
    browserUrl: `http://127.0.0.1:${port}/#token=${token}`,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
