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
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnUi } from './pty.mjs'
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

/**
 * The picker's model rows, cursor marked.
 *
 * Kept narrow on purpose: the session list is the same component with a
 * different row shape, and a helper that tries to be clever about both ends up
 * matching neither.
 */
function rows() {
  const out_ = []
  for (const line of frame()) {
    const text = leftOf(line)
    // A path row too: the directory list is this same component, and a helper
    // that only knows models makes every assertion about it vacuously true.
    if (/^(❯ )?(zen\/|go\/|\/|✎)/.test(text) && !/^\s*\S*█\s*$/.test(text)) out_.push(text)
  }
  return out_
}

/** The picker's session rows: eight hex characters, cursor marked. */
function sessionRows() {
  const out_ = []
  for (const line of frame()) {
    const text = leftOf(line)
    if (/^(❯ )?[0-9a-f]{8}\s/.test(text)) out_.push(text)
  }
  return out_
}

/** The picker's hint row: the keys it names for itself. */
const hint = () => frame().map(strip).find(l => /↑↓ move/.test(l)) ?? ''
/** The picker's title line: it is the row with a count and a hint on it. */
const title = () => frame().map(strip).find(l => /^\S.*\(\d+( of \d+)?\).*·/.test(l)) ?? ''

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

/** The sessions list: deletable, and the only picker that may be. */
const openDeletable = (initial = 1) => {
  say({
    t: 'pick',
    title: 'Resume which session?',
    deletable: true,
    options: [
      { value: '__none__', label: 'new session' },
      { value: 'abc12345', label: 'abc12345  finished      2/3     4h      Add pagination' },
      { value: 'def67890', label: 'def67890  conversing    0/0     9m      pending' },
    ],
    initial,
  })
  return wait(800)
}

/** The directory list: recommendations, and a path you can type. */
const openEditable = (initial = 0) => {
  say({
    t: 'pick',
    title: 'Which directory?',
    editable: true,
    options: [
      { value: '/home/me/vajra', label: '/home/me/vajra  (current)' },
      { value: '/home/me/vajra/examples', label: '/home/me/vajra/examples  (recent)' },
      { value: '/home/me', label: '/home/me  (home)' },
    ],
    initial,
  })
  return wait(800)
}

/** The draft line, while a path is being typed. */
const draft = () => frame().find(l => l.includes('█')) ?? ''

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
  // How many rows fit is a function of the terminal; how many matched is not.
  check('the list narrows to the gpt-5.4 family', /\(4 of 22\)/.test(title()), title())
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
  if (process.env.DBG) console.log('TITLE4:', JSON.stringify(title()))
  shot('4. "gpt54pro" — the cursor is on the pro, which survived the filter')
  check('the filtered list is the pro alone', /\(1 of 22\)/.test(title()), title())
  check('and the cursor is still on it', list[0]?.startsWith('❯') && list[0].includes('gpt-5.4-pro'), JSON.stringify(list))
}

// ── a name is a name, and the numbers are not searchable ──────────────────
for (let i = 0; i < 8; i++) type(BACKSPACE)
type('bunny')
await wait(800)
{
  const list = rows()
  shot('5. "bunny" — a name, found without its punctuation')
  check('a name is found in the id', /\(1 of 22\)/.test(title()) && list.some(r => r.includes('space-bunny-free')), JSON.stringify(list))
}
for (let i = 0; i < 8; i++) type(BACKSPACE)
type('flash')
await wait(800)
{
  const list = rows()
  check('a family suffix narrows to that suffix', list.every(r => r.includes('flash')) && !/\(1 of/.test(title()), `${title()} ${JSON.stringify(list)}`)
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
  check('and the picker is still open, filter intact', /no match|no match for|Which model\?|Resume which session\?/.test(title()) || /model|zzz/.test(title()), title())
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
  check('one model matches', /\(1 of 22\)/.test(title()), title())
}
const before = said.filter(m => m.t === 'pick').length
type(CR)
await wait(800)
{
  const picks = said.filter(m => m.t === 'pick')
  check('Enter sends the highlighted value', picks.length === before + 1 && picks.at(-1)?.value === 'zen/claude-opus-4-5', JSON.stringify(picks.at(-1)))
  check('and the picker is closed', !/\((\d+|\d+ of \d+)\).*·/.test(title()), title())
  check('and the input is cleared', !leftOf(frame()[frame().findIndex(l => l.includes('▀')) - 1] ?? '').startsWith('claude'), 'the query is still in the input')
}

// ── escape answers the host ───────────────────────────────────────────────
// The host is waiting on the promise `ask` returned. A picker closed with
// escape used to send nothing at all, so `/reasoning`, `/model` and `/dir` hung
// for the rest of the session and the next one queued behind it.
await open(0)
{
  const before = said.filter(m => m.t === 'pick').length
  type(ESC)
  await wait(800)
  const picks = said.filter(m => m.t === 'pick')
  check('escape answers the host with nothing chosen', picks.length === before + 1 && picks.at(-1)?.value === null, JSON.stringify(picks.at(-1)))
  check('the picker is closed', !/\((\d+|\d+ of \d+)\).*·/.test(title()), title())
  check('and the input is empty again', !leftOf(frame()[frame().findIndex(l => l.includes('▀')) - 1] ?? '').startsWith('/'), 'the query is still in the input')
  // And a picker still opens after a dismissal: the host is free again.
  await open(0)
  check('a picker opens again after a dismissal', /Which model\?/.test(title()), title())
}
{
  type(ESC)
  await wait(500)
}

// ── deleting from a list, and only from a list that allows it ─────────────
await openDeletable(1)
{
  check('the panel names the chord', /ctrl\+d delete/.test(hint()), hint())
  const before = said.filter(m => m.t === 'pick').length
  child.stdin.write('\x04') // ctrl-d
  await wait(700)
  const picks = said.filter(m => m.t === 'pick')
  check(
    'ctrl-d asks the host to delete the highlighted row',
    picks.length === before + 1 && picks.at(-1)?.action === 'delete' && picks.at(-1)?.value === 'abc12345',
    JSON.stringify(picks.at(-1)),
  )
}
await open(1)
{
  const before = said.filter(m => m.t === 'pick').length
  child.stdin.write('\x04') // ctrl-d on a list that cannot be deleted
  await wait(700)
  check(
    'and a list that cannot be deleted ignores it',
    said.filter(m => m.t === 'pick').length === before,
    'a delete was sent for a list of models',
  )
  check('and its hint does not advertise one', !/ctrl\+d/.test(hint()), hint())
}
await openDeletable(1)
{
  // The filter shares the input line with the chord, and a session id is hex:
  // typing a d must filter, not delete.
  child.stdin.write('def')
  await wait(800)
  check('a typed d filters instead of deleting', /“def”/.test(title()), title())
  check('and the list narrowed to the one that matches', /\(1 of 3\)/.test(title()), title())
  check('and the row on screen is that one', sessionRows().some(r => r.includes('def67890')), JSON.stringify(sessionRows()))
}
// ── a list that takes a typed value, not only a chosen one ───────────────
await openEditable(0)
{
  check('the list offers a row for typing one', rows().some(r => r.includes('type a path')), JSON.stringify(rows()))
  check('and the recommendations are still there', rows().length === 4, `${rows().length} rows`)
  // Taking that row must not answer the host: it is a keyboard mode, and a host
  // told to use a path of "\u0000path" would fail on a path that cannot exist.
  const before = said.filter(m => m.t === 'pick').length
  child.stdin.write('\r')
  await wait(700)
  check(
    'choosing it asks nothing yet',
    said.filter(m => m.t === 'pick').length === before,
    'a pick was sent for the type-a-path row',
  )
  check('and the draft is up', draft().includes('path/to/a/project'), draft())
}
{
  child.stdin.write('/home/me/new')
  await wait(800)
  check('typing goes to the draft, not the filter', draft().includes('/home/me/new'), draft())
  check('and the placeholder is gone', !draft().includes('path/to/a/project'), draft())
  // The list behind the draft is the candidates, not the four recommendations:
  // typing a path is the one thing here that has something to narrow to.
  check('and the list is the candidates, narrowed by the draft', rows().length > 0 && rows().length < 4, `${rows().length} rows`)
  child.stdin.write('\x7f')
  await wait(400)
  check('backspace edits it', !draft().includes('/home/me/new') && draft().includes('/home/me/ne'), draft())
}
{
  child.stdin.write('\x1b')
  await wait(600)
  check('esc puts the list back rather than closing', rows().length === 4 && draft() === '', `rows=${rows().length} draft=${JSON.stringify(draft())}`)
  child.stdin.write('\r') // back into the draft
  await wait(600)
  child.stdin.write('/home/me/typed')
  await wait(700)
  child.stdin.write('\r')
  await wait(800)
  const picks = said.filter(m => m.t === 'pick')
  check(
    'enter sends the typed path as the answer',
    picks.at(-1)?.value === '/home/me/typed' && picks.at(-1)?.action !== 'delete',
    JSON.stringify(picks.at(-1)),
  )
  check('and the picker is closed', rows().length === 0, JSON.stringify(rows()))
}
await open(0)
{
  check('a list that is not editable has no such row', !rows().some(r => r.includes('type a path')), JSON.stringify(rows()))
  child.stdin.write('gpt')
  await wait(700)
  check('and its keys are still the filter', /“gpt”/.test(title()), title())
}

type(ESC)
await wait(500)

close()
console.log(failures === 0 ? '\nOK — the picker filters, ranks and picks' : `\nFAIL\n${problems.map(p => ` - ${p}`).join('\n')}`)
process.exit(failures === 0 ? 0 : 1)
