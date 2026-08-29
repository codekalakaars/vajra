import { context, build } from 'esbuild'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWatch = process.argv.includes('--watch')
const isProd = process.argv.includes('--prod')

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
  minify: isProd,
  sourcemap: !isProd,
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
  },
})

if (isWatch) {
  await ctx.watch()
  console.log('Watching for changes...')

  const { host, port } = await ctx.serve({
    servedir: outdir,
    port: 8080,
  })
  console.log(`Dev server running at http://${host}:${port}`)
} else {
  await ctx.rebuild()
  await ctx.dispose()
  console.log('Build complete.')
}
