/**
 * Select text with the mouse, and check it reaches the clipboard.
 *
 * The one feature in this screen that has no pixels to assert on: a copy is an
 * OSC 52 escape sequence written to stdout, invisible in the reconstructed
 * frame and the entire point. So this drives a real pty, sends a real SGR mouse
 * drag across a real answer, and then looks for the sequence the renderer emits
 * — plus the one-line report the status row shows in exchange.
 *
 *   node scripts/select.mjs
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { reconstruct } from './screen.mjs'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COLS = 120
const ROWS = 30
const feed = join(mkdtempSync(join(tmpdir(), 'vajra-feed-')), 'feed.ndjson')
// The UI watches the file, and a watch on a path that does not exist yet is a
// hard error — so the feed exists, empty, before the screen starts.
writeFileSync(feed, '')

const ANSWER = [
  '## What changed',
  '',
  'The store now **replaces** the task list instead of merging into it.',
  '',
  '- `setTasks` builds a fresh array',
  '- `applyTaskEvent` no longer appends',
].join('\n')

const state = (over = {}) => ({
  t: 'state',
  state: {
    version: '0.0.1',
    model: 'zen/space-bunny-free',
    projectDir: pkg,
    entries: [
      { kind: 'banner', version: '0.0.1' },
      { kind: 'user', text: 'fix the todos clobber' },
      { kind: 'assistant', text: ANSWER },
    ],
    streaming: '',
    thinking: '',
    prompt: { kind: 'user', label: 'What would you like me to work on?' },
    tasks: [],
    executionIndex: 0,
    executionTotal: 0,
    interrupted: false,
    usage: { promptTokens: 18400, completionTokens: 1200, calls: 7, lastPromptTokens: 9200 },
    reasoning: 'off',
    reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
    modelInfo: {
      id: 'zen/space-bunny-free',
      name: 'Space Bunny Free',
      context: 262144,
      reasoning: true,
      reasoningMode: 'effort',
      levels: ['off', 'low', 'medium', 'high', 'xhigh'],
      cost: { input: 0, output: 0, cacheRead: 0 },
      status: 'available',
      toolCall: true,
    },
    tick: 1,
    ...over,
  },
})

const child = spawn('script', ['-qfec', `stty rows ${ROWS} cols ${COLS}; bun src/main.tsx --feed ${feed}`, '/dev/null'], {
  cwd: pkg,
  env: { ...process.env, TERM: 'xterm-256color' },
  stdio: ['pipe', 'pipe', 'inherit'],
})

let out = ''
child.stdout.on('data', d => {
  out += d.toString()
})
const wait = ms => new Promise(r => setTimeout(r, ms))
const send = o => appendFileSync(feed, JSON.stringify(o) + '\n')

/** SGR mouse: button 0 press, button 0 held (drag), button 0 release. */
const press = (col, row) => child.stdin.write(`\x1b[<0;${col};${row}M`)
const drag = (col, row) => child.stdin.write(`\x1b[<32;${col};${row}M`)
const release = (col, row) => child.stdin.write(`\x1b[<0;${col};${row}m`)

/** Every OSC 52 payload the renderer wrote, decoded from base64. */
function clipboardWrites() {
  const found = []
  for (const match of out.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)/g)) {
    found.push(Buffer.from(match[1], 'base64').toString('utf-8'))
  }
  return found
}

await wait(2000)
send(state())
await wait(800)

/**
 * Where the sentence we want actually landed, in 1-based terminal cells.
 *
 * Found by reading the frame rather than guessed: the transcript scrolls, the
 * answer is markdown, and a drag at the wrong row selects a blank line and
 * proves nothing about selection at all.
 */
const TARGET = 'The store now replaces'
const frame = reconstruct(out, COLS, ROWS).split('\n')
const row = frame.findIndex(line => line.includes(TARGET))
if (row === -1) {
  console.error('FAIL\n - the target line is not on screen; the frame is not what this script expects')
  child.kill('SIGKILL')
  process.exit(1)
}
const col = frame[row].indexOf(TARGET) + 1
const endCol = Math.min(COLS, col + TARGET.length)

// A real hand sends many motion events; the copy must still happen once, at the
// end, for what was selected when the hand stopped.
press(col, row + 1)
for (let c = col + 4; c <= endCol; c += 6) {
  drag(c, row + 1)
  await wait(30)
}
drag(endCol, row + 1)
await wait(250)
release(endCol, row + 1)
await wait(500)

if (process.env.DUMP) console.log('RAW:', JSON.stringify(out.slice(0, 600)))
const writes = clipboardWrites()
console.log('\n=== what the terminal was told')
for (const text of writes) console.log(JSON.stringify(text))

console.log('\n=== the screen after the copy')
console.log(reconstruct(out, COLS, ROWS))

const copied = writes.join('')
const problems = []
if (writes.length === 0) problems.push('no OSC 52 write: the selection never reached the clipboard')
if (writes.length > 1) problems.push(`${writes.length} clipboard writes for one drag: the debounce is not holding`)
if (copied.length === 0) problems.push('the clipboard was written empty')
if (!copied.includes('The store now replaces')) {
  problems.push(`the copied text is not the selected line: ${JSON.stringify(copied)}`)
}
if (!/\[\?1006h/.test(out)) {
  problems.push('the renderer never asked the terminal for SGR mouse reporting')
}
if (!/copied \d+ lines?/.test(out)) {
  problems.push('the status row never reported the copy')
}

child.kill('SIGKILL')
if (problems.length > 0) {
  console.error(`\nFAIL\n${problems.map(p => ` - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log('\nOK — one drag, one clipboard write, of the line under the pointer')
process.exit(0)
