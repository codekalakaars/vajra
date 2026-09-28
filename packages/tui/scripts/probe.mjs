/**
 * Drive the real screen: run `bun src/main.tsx` on a pty (via script(1), so
 * no native build is needed), feed it the NDJSON a Node host would send, type
 * at it, and print the frames it painted. Ink's renderer is not in the loop.
 *
 *   node scripts/probe.mjs
 */
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnUi } from './pty.mjs'
import { reconstruct } from './screen.mjs'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COLS = 120
const ROWS = Number(process.env.PROBE_ROWS ?? 30)

// A real answer: a heading, prose, a list, a fenced block and a table, so the
// markdown path is exercised rather than assumed.
const ANSWER = [
  '## What changed',
  '',
  'The store now **replaces** the task list instead of merging into it.',
  '',
  '- `setTasks` builds a fresh array',
  '- `applyTaskEvent` no longer appends',
  '',
  '```ts',
  'const next = [...state.tasks]',
  'next[index] = { ...task, status }',
  'this.set({ tasks: next })',
  '```',
  '',
  '| file | change |',
  '| --- | --- |',
  '| store.ts | replaced |',
  '| test | added |',
].join('\n')

const state = (over = {}) => ({
  t: 'state',
  state: {
    version: '0.0.1',
    model: 'space-bunny-free',
    projectDir: '/mnt/drive/Repo/vajra',
    entries: [
      { kind: 'banner', version: '0.0.1' },
      { kind: 'user', text: 'fix the todos clobber' },
      { kind: 'info', text: 'Developer  planned 3 tasks' },
      { kind: 'tool', tool: 'read_file', summary: 'src/tui/session/store.ts', agent: 'Fix the clobber', status: 'ok', ms: 12 },
      { kind: 'tool', tool: 'edit_file', summary: 'src/tui/session/store.ts', agent: 'Fix the clobber', status: 'running' },
    ],
    streaming: '',
    thinking: '',
    // A user turn, as the store produces one: no label. The first-run label
    // lives on the 'initial-first' prompt, and a user turn is not a question.
    prompt: { kind: 'user', label: '' },
    tasks: [
      { title: 'Fix the clobber in the store', status: 'running', activity: { tool: 'edit_file', summary: 'store.ts', since: Date.now() } },
      { title: 'Add a regression test', status: 'pending' },
    ],
    executionIndex: 0,
    executionTotal: 2,
    interrupted: false,
    usage: { promptTokens: 18400, completionTokens: 1200, calls: 7, lastPromptTokens: 9200 },
    reasoning: 'off',
    // What the host sends once the catalog has landed: the dial for this model
    // and the facts the sidebar draws. Shaped exactly as models/catalog.ts
    // builds it, because a probe that invents its own shape proves nothing.
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
    tick: 0,
    ...over,
  },
})

const COMMANDS = [
  { name: 'help', summary: 'List the commands' },
  { name: 'model', summary: 'Change the model (applies from the next task)' },
  { name: 'dir', summary: 'Change directory — ends this conversation' },
  { name: 'sessions', summary: 'Resume a persisted session' },
  { name: 'reasoning', summary: 'Cycle how hard the model thinks, over the levels this model accepts' },
  { name: 'quit', summary: 'Exit Vajra (alias /exit)' },
]

// The screen takes keys from the pty and NDJSON from a file, so the host's
// writes can never be typed into the prompt. script(1) provides the pty; stty
// sets its size, because script has no size flag of its own.
const feed = join(mkdtempSync(join(tmpdir(), 'vajra-feed-')), 'feed.ndjson')
appendFileSync(feed, '')

const { child, close } = spawnUi({
  command: `bun src/main.tsx --feed ${feed}`,
  cwd: pkg,
  env: { ...process.env, TERM: 'xterm-256color' },
  cols: COLS,
  rows: ROWS,
})

let out = ''
child.stdout.on('data', d => {
  out += d.toString()
})
const wait = ms => new Promise(r => setTimeout(r, ms))
const send = o => appendFileSync(feed, JSON.stringify(o) + '\n')
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const type = s => child.stdin.write(s)
/**
 * OpenTUI sends deltas, not full repaints, so the whole byte history is kept
 * and every shot reconstructs from the start: the cell map is stateful, which
 * is exactly how the terminal itself behaves.
 */
const shot = (title, note) => {
  console.log(`\n=== ${title}${note ? `\n--- ${note}` : ''}`)
  console.log(reconstruct(out, COLS, ROWS))
}

await wait(2000)
send({ t: 'commands', commands: COMMANDS })
send(state())
await wait(800)
shot('1. a fresh session: banner, transcript, prompt placeholder, model, footer', 'nothing typed, one task running')

type('/rea')
await wait(700)
shot('2. typed "/rea" — the palette filters and highlights, textarea keeps focus')

type('[B')
await wait(600)
shot('3. down arrow — claimed by the screen, so the textarea never sees it')

type('[A\r')
await wait(500)
shot('4. enter on a palette row picks the command instead of submitting text')

send(state({ prompt: null, streaming: 'I fixed the store so the task list is replaced, not merged.', thinking: 'checking the regression test still fails without the fix', reasoning: 'high' }))
await wait(900)
shot('5. working: spinner + reasoning high on the status row, tail streaming in the transcript', 'no context meter anywhere; the sidebar carries status and tasks')

send(state({ entries: [
  { kind: 'banner', version: '0.0.1' },
  { kind: 'user', text: 'fix the todos clobber' },
  { kind: 'success', text: 'Done in 42s · 3 tasks' },
  { kind: 'assistant', text: ANSWER },
  { kind: 'info', text: '2 rounds · in 18.4k · out 1.2k' },
], tasks: [
  { title: 'Fix the clobber in the store', status: 'done' },
  { title: 'Add a regression test', status: 'done' },
], executionIndex: 2, streaming: '', thinking: '' }))
await wait(700)
shot('6. run finished: the prompt is back, unlabelled')

type('fix the todos clobber')
await wait(500)
shot('6b. typed into it: the input is a bare row with a cursor, no prefix')

send({ t: 'pick', title: 'Resume which session?', options: [
  { value: 'a1b2c3d4', label: 'a1b2c3d4  fix the todos clobber  ·  2h ago' },
  { value: 'e5f6a7b8', label: 'e5f6a7b8  add a benchmark  ·  yesterday' },
  { value: '11223344', label: '11223344  initial import  ·  3d ago' },
] })
await wait(700)
shot('7. a picker takes over the prompt area')

send({ t: 'exit', code: 0 })
await wait(600)
shot('8. exit')

close()
process.exit(0)
