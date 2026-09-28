/**
 * End-to-end: run the real `vajra` binary on a pty and see whether the OpenTUI
 * screen comes up, accepts a task, and reports back. Nothing is stubbed except
 * the model — there is no API key here, so the run is expected to fail, and
 * that failure is itself worth seeing: it must land in the transcript.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawnUi } from './pty.mjs'
import { reconstruct } from './screen.mjs'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const COLS = 110
const ROWS = 28

const { child, close } = spawnUi({
  command: `node ${pkg}/cli/dist/index.js`,
  cwd: pkg,
  env: { ...process.env, TERM: 'xterm-256color', VAJRA_BUN: process.env.VAJRA_BUN ?? 'bun' },
  cols: COLS,
  rows: ROWS,
})

let out = ''
child.stdout.on('data', d => {
  out += d.toString()
})
const wait = ms => new Promise(r => setTimeout(r, ms))
const shot = title => {
  console.log(`\n=== ${title}`)
  console.log(reconstruct(out, COLS, ROWS))
}

await wait(6000)
shot('1. vajra starting up: is the OpenTUI screen there?')

child.stdin.write('/he')
await wait(400)
child.stdin.write('lp')
await wait(600)
shot('2. typed /help — the palette filters and highlights')

child.stdin.write('\r')
await wait(1200)
shot('3. enter picks the command instead of submitting the text')

child.stdin.write('\x12') // ctrl-r
await wait(1200)
shot('4. ctrl-r — the reasoning dial')

child.stdin.write('/quit')
await wait(500)
child.stdin.write('\r')
await wait(1500)
shot('5. /quit')

close()
process.exit(0)
