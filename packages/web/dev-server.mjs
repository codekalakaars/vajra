import { context } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outdir = join(__dirname, 'dist')
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true })

// Copy static assets
cpSync(join(__dirname, 'public'), outdir, { recursive: true })

const ctx = await context({
  entryPoints: [join(__dirname, 'src', 'index.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir,
  sourcemap: true,
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"development"',
  },
})

await ctx.watch()
console.log('Watching for changes...')

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  let filePath = join(outdir, url.pathname)

  // Try to serve the exact file; fall back to index.html for SPA routes
  try {
    if (statSync(filePath).isFile()) {
      const ext = extname(filePath)
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
      res.end(readFileSync(filePath))
      return
    }
  } catch {}

  // SPA fallback
  const index = join(outdir, 'index.html')
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(readFileSync(index))
})

const PORT = 8080
server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`)
})
