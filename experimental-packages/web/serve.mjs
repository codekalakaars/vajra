import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = join(__dirname, 'dist')
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let filePath = join(DIST, url.pathname)

  // Serve file if it exists
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    })
    res.end(readFileSync(filePath))
    return
  }

  // SPA fallback — serve index.html for all non-file routes
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(readFileSync(join(DIST, 'index.html')))
})

server.listen(8080, () => {
  console.log('SPA dev server running at http://localhost:8080')
})
