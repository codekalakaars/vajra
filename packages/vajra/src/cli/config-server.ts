import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createSandboxConfig,
  isMaskedName,
  loadSandboxConfig,
  loadSandboxEnvironments,
  resolveFilePermission,
  saveSandboxConfig,
  saveSandboxEnvironments,
  scanProject,
  type FilePermissions,
  type SandboxConfig,
} from '@codekalakaars/vajra-sandbox'

const DENY: FilePermissions = { read: false, write: false, edit: false, delete: false }
const MAX_BODY_BYTES = 1024 * 1024

function currentConfig(projectRoot: string, environment: string): SandboxConfig {
  return loadSandboxConfig(projectRoot, environment) ?? createSandboxConfig({
    projectDir: projectRoot,
    defaultPermissions: DENY,
  })
}

function visibleFileCatalog(projectRoot: string, environment: string) {
  const config = currentConfig(projectRoot, environment)
  return [
    { path: '', directory: true, permissions: resolveFilePermission(config, '') },
    ...scanProject(projectRoot)
      .filter((entry) => !entry.path.split('/').some((part) => part.startsWith('.') && part !== '.sample.env'))
      .filter((entry) => entry.isDir || (!entry.isMasked && !isMaskedName(entry.name)))
      .map((entry) => ({
        path: entry.path,
        directory: entry.isDir,
        permissions: resolveFilePermission(config, entry.path),
      })),
  ]
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('Request body must be valid JSON')) }
    })
    request.on('error', reject)
  })
}

function permission(value: unknown): FilePermissions {
  if (!value || typeof value !== 'object') throw new Error('Each file needs a permissions object')
  const record = value as Record<string, unknown>
  for (const key of ['read', 'write', 'edit', 'delete']) {
    if (typeof record[key] !== 'boolean') throw new Error(`Permission '${key}' must be true or false`)
  }
  return { read: record.read as boolean, write: record.write as boolean, edit: record.edit as boolean, delete: record.delete as boolean }
}

function equalToken(received: string | undefined, expected: string): boolean {
  if (!received) return false
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function html(url: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vajra file access</title>
<style>
body{font:15px system-ui,sans-serif;max-width:1050px;margin:32px auto;padding:0 16px;color:#18212b}h1{margin-bottom:4px}p{color:#536170}.bar{position:sticky;top:0;background:#fff;padding:12px 0;border-bottom:1px solid #d8dee6;display:flex;gap:12px;align-items:center}button{padding:8px 14px;border:0;border-radius:5px;background:#185adb;color:white;font-weight:600;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{text-align:left;border-bottom:1px solid #e5e9ef;padding:9px 6px}th:not(:first-child),td:not(:first-child){text-align:center;width:85px}code{overflow-wrap:anywhere}.status{margin-left:auto}input{width:18px;height:18px}
</style>
<h1>Vajra file access</h1><p>Choose which project files the protected shell can read, write, edit, or delete. Changes take effect on the next filesystem operation.</p>
<div class="bar"><button id="save">Save access</button><button id="refresh">Refresh file list</button><span class="status" id="status"></span></div>
<table><thead><tr><th>Project path (folders apply to all contents)</th><th>Read</th><th>Write</th><th>Edit</th><th>Delete</th></tr></thead><tbody id="files"></tbody></table>
<script>
const token=decodeURIComponent(location.hash.slice(1)), api=${JSON.stringify(url)};history.replaceState(null,'',location.pathname);let rows=[];
async function refresh(){document.querySelector('#status').textContent='Loading…';const r=await fetch(api+'/api/files');if(!r.ok)throw new Error('Could not load files');rows=await r.json();const body=document.querySelector('#files');body.replaceChildren();for(const row of rows){const tr=document.createElement('tr'),name=document.createElement('td'),code=document.createElement('code');code.textContent=row.path?(row.directory?row.path+'/**':row.path):'** (project root)';name.append(code);tr.append(name);for(const key of ['read','write','edit','delete']){const td=document.createElement('td'),box=document.createElement('input');box.type='checkbox';box.checked=row.permissions[key];box.dataset.path=row.path;box.dataset.directory=String(row.directory);box.dataset.right=key;td.append(box);tr.append(td)}body.append(tr)}document.querySelector('#status').textContent=(rows.length-1)+' project paths'}
document.querySelector('#refresh').onclick=()=>refresh().catch(showError);
document.querySelector('#save').onclick=async()=>{try{const permissions={};for(const box of document.querySelectorAll('input[type=checkbox]')){permissions[box.dataset.path]??={read:false,write:false,edit:false,delete:false};permissions[box.dataset.path][box.dataset.right]=box.checked}const response=await fetch(api+'/api/config',{method:'POST',headers:{'content-type':'application/json','x-vajra-token':token},body:JSON.stringify(permissions)});if(!response.ok)throw new Error(await response.text());document.querySelector('#status').textContent='Saved; access is live'}catch(e){showError(e)}};
function showError(e){document.querySelector('#status').textContent=String(e)}refresh().catch(showError);
</script></html>`
}

export async function startConfigServer(projectRootInput: string, environment = 'default') {
  const projectRoot = resolve(projectRootInput)
  const token = randomBytes(32).toString('hex')
  let address: { port: number } | undefined
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host
      if (host !== '127.0.0.1' && host !== `127.0.0.1:${address?.port}`) {
        sendJson(response, 403, { error: 'Local connections only' })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (request.method === 'GET' && pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" })
        response.end(html(`http://127.0.0.1:${address?.port}`))
        return
      }
      const validToken = equalToken(request.headers['x-vajra-token'] as string | undefined, token)
      if (request.method === 'GET' && pathname === '/api/files') {
        if (!validToken) {
          sendJson(response, 403, { error: 'Invalid settings session' })
          return
        }
        sendJson(response, 200, visibleFileCatalog(projectRoot, environment))
        return
      }
      if (request.method === 'POST' && pathname === '/api/config') {
        if (!validToken || request.headers.origin !== `http://127.0.0.1:${address?.port}`) {
          sendJson(response, 403, { error: 'Invalid settings session' })
          return
        }
        const submitted = await readBody(request)
        if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) throw new Error('Expected a path-to-permissions object')
        const allowedPaths = new Set(visibleFileCatalog(projectRoot, environment).map((row) => row.path))
        const directories = new Set(visibleFileCatalog(projectRoot, environment).filter((row) => row.directory).map((row) => row.path))
        const fileRules = Object.entries(submitted as Record<string, unknown>).map(([path, raw]) => {
          if (!allowedPaths.has(path) || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Unknown or blocked project path: ${path}`)
          if (/[*!?]/.test(path)) throw new Error(`Cannot configure a path whose name contains glob characters: ${path}`)
          const permissions = permission(raw)
          const pattern = directories.has(path) ? (path ? `${path}/**` : '**') : path
          return { pattern, ...permissions }
        })
        const next = createSandboxConfig({ projectDir: projectRoot, defaultPermissions: DENY, fileRules })
        const configPath = resolve(projectRoot, '.vajra-sandbox.json')
        try {
          const info = lstatSync(configPath)
          if (info.isSymbolicLink() || !info.isFile()) throw new Error('The sandbox config must be a regular file')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (environment === 'default') {
          const environments = loadSandboxEnvironments(projectRoot)
          if (Object.keys(environments).length > 1 || Object.keys(environments).some((name) => name !== 'default')) {
            saveSandboxEnvironments(projectRoot, { ...environments, default: next })
          } else saveSandboxConfig(projectRoot, next)
        } else {
          saveSandboxEnvironments(projectRoot, { ...loadSandboxEnvironments(projectRoot), [environment]: next })
        }
        sendJson(response, 200, { ok: true })
        return
      }
      sendJson(response, 404, { error: 'Not found' })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const bound = server.address()
      if (!bound || typeof bound === 'string') return reject(new Error('Could not bind config server'))
      address = { port: bound.port }
      resolveListen()
    })
  })
  const port = address?.port
  if (!port) throw new Error('Could not bind config server')
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    browserUrl: `${url}/#${token}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose())
      server.closeAllConnections()
    }),
  }
}
