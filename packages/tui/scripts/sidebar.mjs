/**
 * The sidebar, at the heights where it has to survive.
 *
 * Tasks were rendered after Context and Model, in a scrollbox with no
 * scrollbar — so on a short terminal the only live thing in the column was the
 * block that got cut, silently. A plan of four tasks in a 30-row terminal
 * showed one row and nothing saying there were three more, which reads as "the
 * tasks were never created" rather than "the column ran out of room".
 *
 * What has to hold, at every height: the tasks are there, the count is the real
 * count, and the block that moves is above the blocks that don't.
 *
 *   node scripts/sidebar.mjs
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnUi } from './pty.mjs'
import { reconstruct } from './screen.mjs'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COLS = Number(process.env.SIDEBAR_COLS ?? 110)

/** Four tasks: enough that one row of a short column cannot hold them all. */
const TASKS = [
  { title: 'Replace the TODO placeholder with a real note', status: 'running' },
  { title: 'Add a regression test for the check script', status: 'pending' },
  { title: 'Update the examples index', status: 'pending' },
  { title: 'Run the check script and confirm it passes', status: 'pending' },
]

const state = (tasks) => ({
  t: 'state',
  state: {
    version: '0.0.1',
    model: 'zen/space-bunny-free',
    projectDir: '/home/me/vajra',
    entries: [{ kind: 'info', text: 'working' }],
    streaming: '',
    thinking: '',
    prompt: null,
    tasks,
    executionIndex: 0,
    executionTotal: tasks.length,
    interrupted: false,
    usage: { lastPromptTokens: 8_334 },
    reasoning: 'off',
    reasoningLevels: ['off', 'low', 'medium', 'high'],
    modelInfo: {
      id: 'zen/space-bunny-free',
      name: 'Space Bunny Free',
      context: 1_000_000,
      output: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0 },
      status: 'available',
      reasoning: true,
      toolCall: true,
    },
    tick: 0,
  },
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failures++
}

/** Boot the real screen at one height and hand it a state. */
async function sidebarAt(rows) {
  const { child, close } = spawnUi({
    command: 'bun src/main.tsx',
    cwd: pkg,
    env: { ...process.env, TERM: 'xterm-256color', VAJRA_FEED_FD: '3', VAJRA_INPUT_FD: '4' },
    cols: COLS,
    rows,
    stdio: ['pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', d => {
    out += d.toString()
  })
  const feed = child.stdio[3]
  feed.write(`${JSON.stringify(state(TASKS))}\n`)
  await wait(2500)
  const lines = reconstruct(out, COLS, rows).split('\n')
  close()
  return lines
}

/** The sidebar column, from the frame's right-hand side. */
const column = (lines) => lines.map(l => l.slice(Math.floor(COLS * 0.6))).filter(l => l.trim())

for (const rows of [30, 20, 14, 11]) {
  const lines = await sidebarAt(rows)
  console.log(`\n=== ${rows} rows ===`)
  console.log(column(lines).join('\n'))
  const visible = TASKS.filter(t => column(lines).some(l => l.includes(t.title.slice(0, 24))))
  check(visible.length === TASKS.length, `every task is on screen (${visible.length}/${TASKS.length})`)
  check(column(lines).some(l => /Tasks\s+4/.test(l)), 'the count says four')
  // A 42-cell column cannot hold a title, and a hard cut reads as the whole one.
  check(
    column(lines).some(l => l.includes('placeholder wit…')),
    'a title too long for the column says it continues',
  )

  // Order: what changes while you watch comes before what does not. Compared
  // only against the blocks that are actually on screen — at 11 rows Model is
  // cut, which is the correct sacrifice, not an ordering failure.
  const at = (re) => lines.findIndex(l => re.test(l))
  const tasksAt = at(/Tasks/)
  check(tasksAt !== -1, 'the block is there at all')
  const below = [['Context', at(/Context/)], ['Model', at(/\bModel\b/)]].filter(([, i]) => i !== -1)
  for (const [name, i] of below) {
    check(tasksAt < i, `and it is above ${name}`)
  }
}

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
