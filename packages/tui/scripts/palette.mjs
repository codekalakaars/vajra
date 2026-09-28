/**
 * The command palette, driven like a user drives it, with the host on the
 * other end of the pipe.
 *
 * The palette is the one control that shares the input line with typing, so
 * almost everything that can go wrong with it is a key claimed twice or an
 * index that outlives the list it points into. None of that shows in a
 * screenshot of one frame — it needs a sequence: filter, move, narrow, pick.
 *
 * The screen runs the way the real host runs it: descriptors 3 and 4 carry the
 * snapshots down and the answers up, so what the UI decided is read as NDJSON
 * off fd 4 rather than scraped out of the terminal, where a stray reply would
 * look like a line of UI.
 *
 *   node scripts/palette.mjs
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnUi } from './pty.mjs'
import { reconstruct } from './screen.mjs'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COLS = Number(process.env.PALETTE_COLS ?? 100)
const ROWS = Number(process.env.PALETTE_ROWS ?? 28)

/** Solid's JSX is a compile-time transform; Bun needs the plugin to run .tsx. */
function solidPreload(root) {
  const resolved = createRequire(join(root, 'package.json')).resolve('@opentui/solid/preload')
  return resolved.endsWith('.node.js') ? resolved.replace(/\.node\.js$/, '.js') : resolved
}

const COMMANDS = [
  { name: 'model', summary: 'Change the model — the live catalog, with context, price and reachability' },
  { name: 'models', summary: 'What the current model can do: context, reasoning levels, price, status' },
  { name: 'dir', summary: 'Change directory — ends this conversation, starts a new one there' },
  { name: 'defaults', summary: 'Save model and directory as persistent defaults' },
  { name: 'sessions', summary: 'Resume or remove a saved session' },
  { name: 'help', summary: 'Show this help' },
  { name: 'quit', summary: 'Exit Vajra' },
]

/** A set whose filter can lose rows: "/r" matches three, "/rea" matches two. */
const NESTED_COMMANDS = [
  { name: 'r', summary: 'short' },
  { name: 'reason', summary: 'a longer command whose summary would wrap without the cut' },
  { name: 'reasoning', summary: 'the reasoning dial' },
]

const snapshot = (over = {}) => ({
  t: 'state',
  state: {
    version: '0.0.1',
    model: 'zen/space-bunny-free',
    projectDir: pkg,
    entries: [
      { kind: 'user', text: 'fix the todos clobber' },
      { kind: 'success', text: 'Done in 42s · 3 tasks' },
    ],
    streaming: '',
    thinking: '',
    prompt: { kind: 'user', label: '' },
    tasks: [{ title: 'Fix the clobber in the store', status: 'done' }],
    executionIndex: 1,
    executionTotal: 1,
    interrupted: false,
    usage: { promptTokens: 18400, completionTokens: 1200, calls: 7, lastPromptTokens: 9200 },
    reasoning: 'off',
    reasoningLevels: ['off', 'low', 'medium', 'high'],
    modelInfo: null,
    tick: 1,
    ...over,
  },
})

const { child, close } = spawnUi({
  command: 'bun src/main.tsx',
  cwd: pkg,
  env: { ...process.env, TERM: 'xterm-256color', VAJRA_FEED_FD: '3', VAJRA_INPUT_FD: '4' },
  cols: COLS,
  rows: ROWS,
  // 0 and 1 are the pty script hands to the screen; 3 and 4 are the two
  // descriptors the UI itself uses, passed through the pty untouched.
  stdio: ['pipe', 'pipe'],
})

const feed = child.stdio[3]
const answers = child.stdio[4]
if (!feed || !answers) throw new Error('the screen needs descriptors 3 and 4')

/** Everything the UI has said to the host, parsed. */
const said = []
let buffered = ''
answers.on('data', chunk => {
  buffered += chunk.toString()
  let nl = buffered.indexOf('\n')
  while (nl !== -1) {
    const line = buffered.slice(0, nl)
    buffered = buffered.slice(nl + 1)
    if (line.trim() !== '') {
      try {
        said.push(JSON.parse(line))
      } catch {
        /* a partial line is not a message */
      }
    }
    nl = buffered.indexOf('\n')
  }
})

let out = ''
child.stdout.on('data', d => {
  out += d.toString()
})

const wait = ms => new Promise(r => setTimeout(r, ms))
const say = message => feed.write(`${JSON.stringify(message)}\n`)
const type = s => child.stdin.write(s)
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const CR = '\r'
const ESC = '\x1b'
const BACKSPACE = '\x7f'
const sent = t => said.filter(m => m.t === t)

const frame = () => reconstruct(out, COLS, ROWS).split('\n')
const strip = line => line.replace(/^[\t ]*[┃│]?[\t ]*/, '')

/**
 * The left column of a row, with the sidebar's cells taken off the end.
 *
 * The frame is the whole terminal, so a palette row arrives with whatever the
 * sidebar painted to its right glued on — and a row measured like that is
 * "wider than the panel" by however wide the sidebar's headings are.
 */
const LEFT_CELLS = COLS - (COLS >= 100 ? 42 : 0) - 3
const leftOf = line => strip(line).slice(0, LEFT_CELLS).replace(/\s+$/, '')

/**
 * The input's own row: the last row with content above the meta row.
 *
 * The meta row is the one that names the model, and it sits between the input
 * and the `╹▀` rule — so "the first row above the rule" is the meta row, not
 * the input, and a probe that looks there reports an empty input on every
 * frame.
 */
function inputRow() {
  const lines = frame()
  const rule = lines.findIndex(l => l.includes('▀'))
  const meta = lines.findIndex((l, i) => i < rule && l.includes('space-bunny-free'))
  const above = meta === -1 ? rule - 1 : meta - 1
  for (let i = above; i >= 0; i--) {
    const text = leftOf(lines[i])
    if (text !== '') return text
  }
  return ''
}

/**
 * The palette's rows: every `/name` line above the input, minus the input.
 *
 * The input starts with a slash too, and it is always the last of them, so it
 * is dropped only when the frame agrees it is the input.
 */
function paletteRows() {
  const input = inputRow()
  const rows = []
  for (const line of frame()) {
    const text = leftOf(line)
    if (/^(❯ )?\/[a-z]/.test(text) && text !== input) rows.push(text)
  }
  return rows
}

/** The RGB escape the renderer writes for a colour, if it wrote one. */
const rgbEscape = hex => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}

let failures = 0
const problems = []
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    problems.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const shot = title => {
  console.log(`\n=== ${title}`)
  console.log(reconstruct(out, COLS, ROWS))
}

await wait(2000)
say({ t: 'commands', commands: COMMANDS })
say(snapshot())
await wait(800)

// ── 1. the whole list, one row per command ──────────────────────────────────
// A terminal with room shows every command. A short one cannot, and the list
// must give way instead of the prompt: these are the two heights' contracts.
const TALL = ROWS >= 24
type('/')
await wait(700)
{
  const list = paletteRows()
  shot(`1. "/" at ${ROWS} rows`)
  if (TALL) {
    check('all seven commands are listed', list.length === COMMANDS.length, `saw ${list.length}: ${JSON.stringify(list)}`)
    check('no scrollbar, because nothing overflows', !list.some(r => /[▀▄█]/.test(r)), JSON.stringify(list))
  } else {
    check('the list is capped rather than the prompt pushed off', list.length < COMMANDS.length, `saw ${list.length}`)
    check('what is shown is still the top of the list', list[0]?.includes('/model'), JSON.stringify(list))
  }
  const lines = frame()
  const first = lines.findIndex(l => strip(l).startsWith('❯ /model'))
  const last = lines.findIndex(l => l.includes('▀') && l.trim().length > 1)
  const ungoverned = lines.slice(first, last).filter(l => l.trim() !== '' && !/^[	 ]{0,3}[┃│]/.test(l))
  check('no row spills outside the panel rule', ungoverned.length === 0, `ungutted rows: ${JSON.stringify(ungoverned)}`)
  check(
    'no row is wider than the panel',
    paletteRows().every(r => r.length <= LEFT_CELLS),
    JSON.stringify(paletteRows().map(r => r.length)),
  )
  check('the closing rule and the status row are still on screen', lines.some(l => l.includes('/ commands')), 'the status row is gone')

  // Two colours, and the cursor has to be findable: the row under the cursor is
  // a light cyan, everything else is a light gray that says "available" and not
  // "switched off".
  const cyan = rgbEscape('#7fd8e0')
  const grey = rgbEscape('#b4b4b4')
  check('unselected rows are painted the light gray', out.includes(grey), 'no light gray in the output stream')
  check('the selected row is painted the light cyan', out.includes(cyan), 'no cyan in the output stream')
  // Which colour belongs to which row: the SGR that sets it is written before
  // the run of text it applies to, so the check looks back from the text rather
  // than after it. (Matching it forward needs a pattern, and an escape sequence
  // in a pattern is a character class.)
  const colourBefore = (text) => {
    const at = out.indexOf(text)
    return at === -1 ? '' : out.slice(Math.max(0, at - 240), at)
  }
  check('the cursor row is the cyan one', colourBefore('❯ /model').includes(cyan), 'the ❯ row was not cyan')
  check('an unselected row is the gray one', colourBefore('  /models').includes(grey), 'an unselected row was not gray')
}

// Scrolling: on a short terminal the cursor must stay visible, and the list must
// move under it.
if (!TALL) {
  type(DOWN)
  type(DOWN)
  type(DOWN)
  await wait(600)
  const list = paletteRows()
  shot('1b. down three times in a scrolling list — the cursor stays visible')
  check('the cursor is on a row that is on screen', list.some(r => r.startsWith('❯')), JSON.stringify(list))
  check('the list scrolled under the cursor', !/^\/model\b/.test(list[0] ?? ''), JSON.stringify(list))
  for (let i = 0; i < 8; i++) type(BACKSPACE)
  await wait(400)
}

// ── 2. filtering and moving the cursor ─────────────────────────────────────
for (let i = 0; i < 6; i++) type(BACKSPACE)
await wait(400)
type('/m')
await wait(700)
{
  const list = paletteRows()
  shot('2. "/m" — two matches, cursor on the first')
  check('the filter narrows to model and models', list.length === 2, JSON.stringify(list))
  check('the cursor starts on the first match', list[0]?.startsWith('❯'), JSON.stringify(list[0]))
}
type(DOWN)
await wait(500)
{
  const list = paletteRows()
  shot('3. down — the cursor moves to the second match')
  check('the cursor moved down', list[1]?.startsWith('❯'), JSON.stringify(list))
  check('the cursor is not on both rows', !list[0]?.startsWith('❯'), JSON.stringify(list))
}

// ── 3. a filter that leaves fewer rows than the cursor is on ───────────────
say({ t: 'commands', commands: NESTED_COMMANDS })
for (let i = 0; i < 6; i++) type(BACKSPACE)
await wait(400)
type('/r')
await wait(700)
type(DOWN)
type(DOWN)
await wait(500)
{
  const list = paletteRows()
  shot('4a. "/r" then down twice — the cursor is on the last of three')
  check('three matches', list.length === 3, JSON.stringify(list))
  check('the cursor is on the third', list[2]?.startsWith('❯'), JSON.stringify(list))
}
type('e')
type('a') // "/rea" — two rows left, the cursor was on the third
await wait(700)
{
  const list = paletteRows()
  shot('4b. "/rea" — the list shrank under the cursor')
  check('two matches left', list.length === 2, JSON.stringify(list))
  check('the cursor is clamped onto a row that exists', list[1]?.startsWith('❯'), JSON.stringify(list))
}
const slashesBefore = sent('slash').length
type(CR)
await wait(800)
{
  check('Enter runs the clamped row', sent('slash').length === slashesBefore + 1, `sent ${JSON.stringify(sent('slash').slice(-1))}`)
  check('the row it ran is the clamped one', sent('slash').at(-1)?.name === 'reasoning', JSON.stringify(sent('slash').at(-1)))
  check('the input is cleared after the pick', !inputRow().startsWith('/rea'), `input row: ${JSON.stringify(inputRow())}`)
  check('the cursor is back at the top for the next command', true)
}

// ── 4. Enter with nothing to run must submit the text ──────────────────────
const submitsBefore = sent('submit').length
type('/zzz')
await wait(700)
{
  check('a query that matches nothing opens no palette', paletteRows().length === 0, JSON.stringify(paletteRows()))
  shot('5. "/zzz" — no matches, so no palette and no claimed Enter')
}
type(CR)
await wait(800)
{
  check('Enter submits the text rather than being swallowed', sent('submit').length === submitsBefore + 1, `sent ${JSON.stringify(sent('submit').slice(-1))}`)
  check('and it submits what was typed', sent('submit').at(-1)?.value === '/zzz', JSON.stringify(sent('submit').at(-1)))
}

// ── 5. vi keys must not eat characters while typing ────────────────────────
type('/mj')
await wait(800)
{
  const line = inputRow()
  shot('6. typed "/mj" — j must reach the input, not be claimed as "down"')
  check('the typed j reached the input', line.includes('/mj'), `input row: ${JSON.stringify(line)}`)
}
type(BACKSPACE)
await wait(500)
{
  const line = inputRow()
  check('and backspace still works with the palette open', line.includes('/m') && !line.includes('/mj'), `input row: ${JSON.stringify(line)}`)
}

// ── 6. a stray Enter must not break the palette ───────────────────────────
// Enter on an empty prompt submits nothing, and it used to leave a newline in
// the textarea anyway: the buffer became "\n", every rule about the draft was
// then a rule about a string with whitespace in it, and the palette stayed shut
// for the rest of the session with nothing on screen to say why.
type(CR)
await wait(700)
{
  shot('7a. Enter on an empty prompt — nothing to submit, nothing left behind')
  check('Enter on an empty prompt left the input empty', !inputRow().startsWith('/'), `input row: ${JSON.stringify(inputRow())}`)
  check('and no newline appeared in the box', inputRow() !== '\n', `input row: ${JSON.stringify(inputRow())}`)
}
type('/re')
await wait(700)
{
  const list = paletteRows()
  shot('7b. then "/re" — the palette must still open')
  check('the palette still filters after a stray Enter', list.length > 0, JSON.stringify(list))
  check('with a cursor on the first match', list[0]?.startsWith('❯'), JSON.stringify(list))
}

// ── 7. escape closes the palette without running anything ──────────────────
const before = sent('slash').length
type(ESC)
await wait(600)
{
  check('escape clears the input', inputRow() !== '/m', `input row: ${JSON.stringify(inputRow())}`)
  check('escape runs no command', sent('slash').length === before, `sent ${JSON.stringify(sent('slash').slice(-1))}`)
  check('and the palette is gone', paletteRows().length === 0, JSON.stringify(paletteRows()))
}

close()
console.log(failures === 0 ? '\nOK — the palette behaves' : `\nFAIL\n${problems.map(p => ` - ${p}`).join('\n')}`)
process.exit(failures === 0 ? 0 : 1)
