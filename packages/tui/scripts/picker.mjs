/**
 * The model picker, with typing as the filter.
 *
 * Seventy-five models, and a picker that could only be walked with the arrow
 * key, was a list you scrolled looking for one name. The input line is the
 * filter now, so what has to hold is: the list narrows as you type, the row
 * you meant comes *first* rather than wherever the gateway listed it, the
 * cursor follows its option through the re-sorting, and a query that matches
 * nothing says so instead of showing a panel with no rows in it.
 *
 *   node scripts/picker.mjs
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { reconstruct } from './screen.mjs'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COLS = Number(process.env.PICKER_COLS ?? 100)
const ROWS = Number(process.env.PICKER_ROWS ?? 28)

/** The shape the host sends: id, then the facts that decide a choice. */
const MODELS = [
  ['zen/gpt-5.4', '272k ctx', 'reasoning low/medium/high/xhigh', '$2.5/$15 per Mtok'],
  ['zen/gpt-5.4-pro', '272k ctx', 'reasoning low/medium/high/xhigh', '$30/$180 per Mtok'],
  ['zen/gpt-5.4-mini', '272k ctx', 'reasoning minimal/low/medium/high', '$0.75/$4.5 per Mtok'],
  ['zen/gpt-5.4-nano', '400k ctx', 'reasoning minimal/low/medium/high', '$0.2/$1.25 per Mtok'],
  ['go/glm-5.3', '1M ctx', 'reasoning low/high/max', '$1.4/$4.4 per Mtok'],
  ['go/glm-5.3-flash', '1M ctx', 'no reasoning', '$0.15/$0.5 per Mtok'],
  ['zen/claude-opus-4-5', '1M ctx', 'reasoning low/medium/high/max', '$5/$25 per Mtok'],
  ['zen/claude-sonnet-4-6', '1M ctx', 'reasoning low/medium/high/max', '$3/$15 per Mtok'],
  ['zen/space-bunny-free', '1M ctx', 'reasoning low/medium/high/xhigh/max', 'free'],
  ['zen/big-pickle', '200k ctx', 'no reasoning', 'free'],
  ['go/kimi-k3', '1M ctx', 'reasoning low/medium/high/xhigh/max', '$3/$15 per Mtok'],
  ['go/kimi-k2.7-code', '256k ctx', 'reasoning low/medium/high', '$0.95/$4 per Mtok'],
  ['zen/deepseek-v4-pro', '1M ctx', 'reasoning low/high/max', '$1.74/$3.48 per Mtok'],
  ['zen/deepseek-v4-flash', '1M ctx', 'no reasoning', '$0.14/$0.28 per Mtok'],
  ['go/qwen3.8-max', '262.1k ctx', 'reasoning toggle', '$2/$6 per Mtok'],
  ['zen/muse-spark-1.2', '1M ctx', 'reasoning minimal/low/medium/high/xhigh', '$1.25/$4.25 per Mtok'],
  ['go/minimax-m3', '1M ctx', 'reasoning low/medium/high', '$0.3/$1.2 per Mtok'],
  ['zen/nemotron-3-ultra-free', '1M ctx', 'no reasoning', 'free'],
  ['zen/mimo-v2.6-flash-free', '200k ctx', 'no reasoning', 'free'],
  ['zen/ling-3.0-flash-fin-free', '262.1k ctx', 'reasoning toggle', 'free'],
  ['go/longcat-2.5-preview-free', '1M ctx', 'reasoning toggle', 'free'],
  ['zen/jev-1.13-free', '128k ctx', 'no reasoning', 'free'],
].map(([id, ...facts]) => ({ value: id, label: [id, ...facts].join('  ·  ') }))

const snapshot = () => ({
  t: 'state',
  state: {
    version: '0.0.1',
    model: 'zen/space-bunny-free',
    projectDir: pkg,
    entries: [{ kind: 'user', text: 'fix the todos clobber' }],
    streaming: '',
    thinking: '',
    prompt: { kind: 'user', label: '' },
    tasks: [],
    executionIndex: 0,
    executionTotal: 0,
    interrupted: false,
    usage: { promptTokens: 18400, completionTokens: 1200, calls: 7, lastPromptTokens: 9200 },
    reasoning: 'off',
    reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    modelInfo: null,
    tick: 1,
  },
})

const child = spawn('script', ['-qfec', `stty rows ${ROWS} cols ${COLS}; bun src/main.tsx`, '/dev/null'], {
  cwd: pkg,
  env: { ...process.env, TERM: 'xterm-256color', VAJRA_FEED_FD: '3', VAJRA_INPUT_FD: '4' },
  stdio: ['pipe', 'pipe', 'inherit', 'pipe', 'pipe'],
})
const feed = child.stdio[3]
const answers = child.stdio[4]
if (!feed || !answers) throw new Error('the screen needs descriptors 3 and 4')

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
        /* partial line */
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
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const CR = '\r'
const ESC = '\x1b'
const BACKSPACE = '\x7f'

const frame = () => reconstruct(out, COLS, ROWS).split('\n')
const strip = line => line.replace(/^[\t ]*[┃│]?[\t ]*/, '')
const LEFT_CELLS = COLS - (COLS >= 100 ? 42 : 0) - 3
const leftOf = line => strip(line).slice(0, LEFT_CELLS).replace(/\s+$/, '')

/** The picker's rows: the model lines inside the panel, cursor marked. */
function rows() {
  const out_ = []
  for (const line of frame()) {
    const text = leftOf(line)
    if (/^(❯ )?(zen|go)\//.test(text)) out_.push(text)
  }
  return out_
}
const title = () => frame().map(strip).find(l => /^Which model\?/.test(l)) ?? ''

let failures = 0
const problems = []
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    problems.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const shot = t => {
  console.log(`\n=== ${t}`)
  console.log(reconstruct(out, COLS, ROWS))
}

const open = (initial = 0) => {
  say({ t: 'pick', title: 'Which model?', options: MODELS, initial })
  return wait(800)
}

await wait(2000)
say(snapshot())
await wait(600)
await open(0)
{
  const list = rows()
  shot('1. the picker, opened on the first model')
  // The panel is capped by the terminal's height, so a full list scrolls rather
  // than overruns the prompt — the whole catalog is offered, not all on screen.
  check('the list is capped, not the whole catalog at once', list.length > 10 && list.length < MODELS.length, `saw ${list.length} of ${MODELS.length}`)
  check('the panel says the line filters', /type to filter/.test(title()), title())
}

// ── typing narrows, and the row you meant comes first ──────────────────────
for (let i = 0; i < 6; i++) type(BACKSPACE)
type('gpt54')
await wait(800)
{
  const list = rows()
  shot('2. typed "gpt54" — the punctuation the user does not type')
  check('the list narrows to the gpt-5.4 family', list.length === 4, `saw ${list.length}: ${JSON.stringify(list.map(r => r.split(' ')[0]))}`)
  check('the exact id is first, not the pro', list[0]?.includes('zen/gpt-5.4  ·'), JSON.stringify(list[0]))
  check('the title counts the matches', /\(4 of 22\)/.test(title()), title())
  check('and quotes the query', /“gpt54”/.test(title()), title())
}

// ── the cursor follows its option through the re-sort ─────────────────────
type(DOWN)
await wait(500)
{
  const list = rows()
  shot('3. down — the cursor moves within the *filtered* list')
  check('the second match is highlighted', list[1]?.startsWith('❯'), JSON.stringify(list))
}
type('pro')
await wait(800)
{
  const list = rows()
  shot('4. "gpt54pro" — the cursor is on the pro, which survived the filter')
  check('the filtered list is the pro alone', list.length === 1, JSON.stringify(list))
  check('and the cursor is still on it', list[0]?.startsWith('❯'), JSON.stringify(list))
}

// ── a name is a name, and the numbers are not searchable ──────────────────
for (let i = 0; i < 8; i++) type(BACKSPACE)
type('bunny')
await wait(800)
{
  const list = rows()
  shot('5. "bunny" — a name, found without its punctuation')
  check('a name is found in the id', list.length === 1 && list[0].includes('space-bunny-free'), JSON.stringify(list))
}
for (let i = 0; i < 8; i++) type(BACKSPACE)
type('flash')
await wait(800)
{
  const list = rows()
  check('a family suffix narrows to that suffix', list.length > 1 && list.every(r => r.includes('flash')), `${list.length} rows`)
}
for (let i = 0; i < 8; i++) type(BACKSPACE)
type('mtok')
await wait(800)
{
  const list = rows()
  // Deliberate: the search is over ids, so the numbers in a row are not a
  // query. Searching the whole label matched almost anything, because `pro` and
  // `llama` are both subsequences of `$1.4/$4.4 per Mtok`.
  check('a price is not searched, so it cannot bury a name', list.length === 0, JSON.stringify(list))
}
for (let i = 0; i < 6; i++) type(BACKSPACE)
type('toggle')
await wait(800)
{
  const list = rows()
  check('nor is a reasoning vocabulary', list.length === 0, JSON.stringify(list))
}

// ── nothing matches: say so, and Enter must not pick ──────────────────────
for (let i = 0; i < 8; i++) type(BACKSPACE)
type('llama')
await wait(800)
{
  const list = rows()
  shot('6. "llama" — no match, and it says so')
  check('the model rows are gone', list.length === 0, JSON.stringify(list))
  check('the panel says there is no match', frame().some(l => /no match for/.test(l)), 'no empty-state line')
}
const picksBefore = said.filter(m => m.t === 'pick').length
type(CR)
await wait(600)
check('Enter with nothing to pick sends nothing', said.filter(m => m.t === 'pick').length === picksBefore, 'a pick was sent')
{
  shot('6b. after Enter with no match: the picker is still open')
  check('and the picker is still open, filter intact', /Which model\?/.test(title()), title())
}
type(ESC)
await wait(600)

// ── pick, and the host gets the value ─────────────────────────────────────
await open(3)
for (let i = 0; i < 6; i++) type(BACKSPACE)
type('claude-opus')
await wait(800)
{
  const list = rows()
  shot('7. "claude-opus" — one row, one cursor')
  check('one model matches', list.length === 1, JSON.stringify(list))
}
const before = said.filter(m => m.t === 'pick').length
type(CR)
await wait(800)
{
  const picks = said.filter(m => m.t === 'pick')
  check('Enter sends the highlighted value', picks.length === before + 1 && picks.at(-1)?.value === 'zen/claude-opus-4-5', JSON.stringify(picks.at(-1)))
  check('and the picker is closed', !/Which model\?/.test(title()), title())
  check('and the input is cleared', !leftOf(frame()[frame().findIndex(l => l.includes('▀')) - 1] ?? '').startsWith('claude'), 'the query is still in the input')
}

child.kill('SIGKILL')
console.log(failures === 0 ? '\nOK — the picker filters, ranks and picks' : `\nFAIL\n${problems.map(p => ` - ${p}`).join('\n')}`)
process.exit(failures === 0 ? 0 : 1)
