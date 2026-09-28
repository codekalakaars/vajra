import { createReadStream, watch, writeSync } from 'node:fs'
import { createCliRenderer, type CliRenderer, type TextareaRenderable } from '@opentui/core'
import { render, useKeyboard, useTerminalDimensions } from '@opentui/solid'
// Adds <spinner> to the intrinsic elements. The frames and colours it renders
// come from ./spinner.ts, which is OpenCode's own.
import 'opentui-spinner/solid'
import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js'
import { bareModel, providerOf, theme } from './theme.js'
import { generateSubtleSyntax } from './syntax.js'
import type { JSX } from '@opentui/solid'
import { createColors, createFrames } from './spinner.js'
import { copyReportLine, installSelectionCopy, type CopyReport } from './clipboard.js'
import { matchCommands, type ClientMessage, type CommandSpec, type Entry, type ServerMessage, type UiState } from './protocol.js'
import { fuzzyFilter } from './fuzzy.js'

/**
 * The Vajra session screen, in Solid.
 *
 * Solid is not a style choice here. OpenCode's TUI is Solid on OpenTUI, so this
 * file is a transcription rather than a translation: the prompt, the gutter, the
 * half-height rule, the meta row and the status row are the shapes in
 * `packages/tui/src/component/prompt/index.tsx` and
 * `packages/tui/src/routes/session/index.tsx`, with their server calls swapped
 * for this app's protocol. The same idioms come with it — `ref={(r) => (input =
 * r)}`, `onContentChange` reading `input.plainText`, `<Show>` for the
 * conditionals — so the code reads the way theirs does.
 *
 * The structural rules that are easy to get wrong, all from their source:
 *  - nothing rules the left edge for the whole frame. Each block draws its own
 *    `border={["left"]}` with a `╹` tick at the bottom-left, which is what makes
 *    the prompt and each message read as separate blocks;
 *  - the prompt's editor sits on `backgroundElement`, so the block is a filled
 *    panel inset by two cells with one row of padding above;
 *  - the meta row is *inside* that panel, `paddingTop 1`, `space-between`: what
 *    you are talking to on the left, and a caller-supplied slot on the right
 *    (OpenCode passes a plugin slot; we pass nothing);
 *  - the closing rule is two boxes — a `╹` in the gutter, then a `▀` across the
 *    panel. A half-height line needs a custom border character, not a style;
 *  - below that sits the status row: the spinner and what it is doing on the
 *    left, or the directory when idle; usage on the right once there is any, and
 *    the key hints until then. There is no version anywhere.
 *
 * Library notes, learned the hard way:
 *  - a root box is sized with numbers from `useTerminalDimensions()`, because
 *    percentage sizing does not resolve against the renderer root;
 *  - `useKeyboard` runs before the focused renderable, so a palette key is
 *    claimed with `preventDefault()` and the textarea never sees it;
 *  - a `<textarea>` has no `value`; its text is `plainText`;
 *  - a `<text>` may contain strings and `<span>`s, never another `<text>`.
 *
 * Three channels, one job each, and they must not be confused:
 *  - stdin and stdout are the terminal. The renderer reads keys from stdin and
 *    paints frames to stdout, and it decides whether to enter raw mode by
 *    asking *stdin* — so stdin has to be the real tty, not a pipe;
 *  - the host's state snapshots arrive on descriptor 3 (`VAJRA_FEED_FD`), or
 *    from a `--feed` file when a probe is driving;
 *  - replies go to the pipe named by `VAJRA_INPUT_FD` (descriptor 4 as the host
 *    wires it), and to stdout only when nothing is listening.
 * Collapsing any two of these is silent and total: a snapshot that lands on the
 * terminal is typed into the prompt, and a keypress on a pipe never arrives.
 */

/** ui/border.ts, verbatim: a border with only its verticals drawn. */
const EmptyBorder = {
  topLeft: '',
  bottomLeft: '',
  vertical: '',
  topRight: '',
  bottomRight: '',
  horizontal: ' ',
  bottomT: '',
  topT: '',
  cross: '',
  leftT: '',
  rightT: '',
}

const SplitBorder = { ...EmptyBorder, vertical: '┃' }

/** The prompt's block: a left rule that ticks in at the bottom-left. */
const PROMPT_BLOCK = { ...SplitBorder, bottomLeft: '╹' }

/** The two-box closing rule: `╹` in the gutter, `▀` across the panel. */
const GUTTER_TICK = { ...EmptyBorder, vertical: '╹' }
const HALF_RULE = { ...EmptyBorder, horizontal: '▀' }

/**
 * The spinner, with OpenCode's exact frames and gradient: a knight-rider sweep
 * over blocks, fading the trail, held at each end. Built once — the frames and
 * the colour generator are pure functions of the theme, and rebuilding them on
 * every render would restart the animation.
 */
/**
 * One palette for the whole screen, built once. OpenCode makes it a memo of the
 * theme; ours has one theme, so a constant is the same thing with less machinery.
 */
const syntax = generateSubtleSyntax()

const spinnerFrames = createFrames({ color: theme.text, style: 'blocks', inactiveFactor: 0.6, minAlpha: 0.3 })
const spinnerColors = createColors({ color: theme.text, style: 'blocks', inactiveFactor: 0.6, minAlpha: 0.3 })

/** OpenCode's sidebar is 42 cells; below this it is not worth the transcript. */
const SIDEBAR_WIDTH = 42
const SIDEBAR_MIN_WIDTH = 100

/**
 * The context window the percentage is measured against, when the catalog has
 * not said.
 *
 * The host sends the size of the last round, not the model's limit, and the
 * model knows its own: the catalog carries `limit.context` for every model it
 * has, and the host puts it in the snapshot. This constant is the floor for a
 * screen that has not been told — a cold cache, or a model the catalog has
 * never heard of — and it is deliberately the same 128k the compaction budget
 * assumes, so a wrong number shows as a conservative meter rather than as a
 * meter that reads 90% on an empty conversation.
 */
const UNKNOWN_CONTEXT_LIMIT = 128_000

/** A picker's own rows: the left rule, the title, and the padding around it. */
const PICKER_CHROME_ROWS = 5

/** The transcript keeps this many rows even with a picker open over it. */
const MIN_TRANSCRIPT_ROWS = 6

/**
 * The row a picker spends on naming its own keys.
 *
 * Counted in the chrome, not taken out of the list: a list of one is a list of
 * one, and the row that says which key deletes it has to fit beside it or not at
 * all. A picker that drops its only row to make room for its own help is a
 * picker that looks broken.
 */
const PICKER_HINT_ROWS = 1

/**
 * The pick value that means "I want to type one", and the row that says so.
 *
 * NUL-prefixed for the same reason the host's "use the default" row is: the
 * picker filters on the value, and anything that looks like ordinary text would
 * be narrowed away by the first letter or matched by accident.
 */
const TYPE_A_PATH = '\u0000path'
const TYPE_A_PATH_LABEL = '✎ type a path'

/** What the draft line shows when there is nothing typed yet. */
const PATH_PLACEHOLDER = '~/path/to/a/project'

/** The air on each side of the left column, so nothing touches the edge. */
const COLUMN_MARGIN = 1

/** A panel's rule and its padding: the cells a row cannot use. */
const PANEL_CHROME_CELLS = 5

/** The cursor in front of the selected row, and the two cells it costs. */
const CURSOR_MARKER = '❯ '

/**
 * What a picker's fuzzy search runs over: the model's id, and nothing else.
 *
 * The id carries every name a user would type — `claude-opus-4-5`,
 * `gpt-5.4`, `glm-5.3`, `kimi-k3`, `space-bunny-free` — because a gateway
 * builds them out of the family's name. The rest of the row is numbers, and
 * matching against numbers is worse than not matching: `pro` is a subsequence
 * of almost any price and vocabulary, so searching the whole label made
 * `gpt54pro` return all four gpt models, and `llama` return seven, ranked by
 * coincidence. The facts are for choosing between the rows you are shown.
 */
const filterText = (option: { value: string; label: string }): string => option.value

/** The icon column every tool row reserves, so the labels line up. */
const INLINE_TOOL_ICON_WIDTH = 2

/** Thinking text is dimmed to the theme's thinking opacity while it streams. */
function thinkingColor(): string {
  return theme.warning
}

/** One line, no wrapping surprises: the row is a single cell high. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Cut a row to the cells it has, with an ellipsis when anything was lost.
 *
 * A row that wraps is the single reason a command palette looks broken: the
 * continuation lands on a line of its own, outside the panel's rule, so seven
 * commands occupy twenty rows and the cursor appears to jump. Truncating keeps
 * one command on one row, and the ellipsis says the text continues rather than
 * pretending the sentence ended there.
 *
 * Counted by code point, not UTF-16 unit, so an emoji or an accent does not
 * cost two cells of budget and push the cut one character early.
 */
function ellipsis(text: string, width: number): string {
  if (width <= 0) return ''
  const cells = Array.from(text)
  if (cells.length <= width) return text
  if (width === 1) return '…'
  return `${cells.slice(0, width - 1).join('')}…`
}

function shortPath(path: string, max: number): string {
  const parts = path.split('/').filter(Boolean)
  const full = `…/${parts.slice(-2).join('/')}`
  return full.length <= max ? full : `…${path.slice(-(max - 1))}`
}

/** Usage the way OpenCode prints it: context, then the tokens, muted, uncut. */
function usageLine(state: UiState): string {
  const { lastPromptTokens, promptTokens, completionTokens } = state.usage
  if (lastPromptTokens <= 0) return ''
  const k = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  return `${k(lastPromptTokens)} · ${k(promptTokens)}↑ ${k(completionTokens)}↓`
}

/** Where the server's NDJSON arrives: fd 3, a `--feed` file, or stdin. */
function openFeed(): AsyncIterable<Buffer> {
  if (process.env.VAJRA_FEED_FD) {
    const stream = createReadStream('', { fd: Number(process.env.VAJRA_FEED_FD), autoClose: false })
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]() }
  }
  const flag = process.argv.indexOf('--feed')
  if (flag !== -1 && process.argv[flag + 1]) return watchFile(process.argv[flag + 1])
  return { [Symbol.asyncIterator]: () => process.stdin[Symbol.asyncIterator]() }
}

/** A file that only grows, read incrementally. This is how the probe feeds us. */
async function* watchFile(path: string): AsyncIterable<Buffer> {
  let offset = 0
  const queue: Buffer[] = []
  let wake: (() => void) | null = null
  const pull = async (): Promise<Buffer | null> => {
    for (;;) {
      const next = queue.shift()
      if (next !== undefined) return next
      await new Promise<void>(resolve => {
        wake = resolve
      })
      wake = null
    }
  }
  const read = async (): Promise<void> => {
    const fs = await import('node:fs/promises')
    try {
      const handle = await fs.open(path, 'r')
      try {
        const size = (await handle.stat()).size
        if (size > offset) {
          const buf = Buffer.alloc(size - offset)
          await handle.read(buf, 0, buf.length, offset)
          offset = size
          queue.push(buf)
          wake?.()
        }
      } finally {
        await handle.close()
      }
    } catch {
      // The file may not exist yet.
    }
  }
  await read()
  const watcher = watch(path, { persistent: false }, () => void read())
  const timer = setInterval(() => void read(), 100)
  try {
    for (;;) {
      const chunk = await pull()
      if (chunk !== null) yield chunk
    }
  } finally {
    watcher.close()
    clearInterval(timer)
  }
}

function App(props: { renderer: CliRenderer }) {
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal<UiState | null>(null)
  const [commands, setCommands] = createSignal<CommandSpec[]>([])
  const [draft, setDraft] = createSignal('')
  /**
   * The cursor, twice, because they are cursors over different lists.
   *
   * One index shared by the palette and a picker meant a filter that left the
   * cursor on row 3 followed the user into the sessions picker, which has two
   * rows, and the highlighted row was one past the end: Enter there did nothing
   * at all, silently, because there was no row to run.
   */
  const [paletteIdx, setPaletteIdx] = createSignal(0)
  const [pickerIdx, setPickerIdx] = createSignal(0)
  const [picker, setPicker] = createSignal<{
    title: string
    options: { value: string; label: string }[]
    deletable: boolean
    /** The list takes a typed value, not only a chosen one. */
    editable: boolean
  } | null>(null)
  /**
   * A path being typed into an editable picker, or null when the list is showing.
   *
   * A second signal rather than a field on the picker because it is a mode, not
   * a value: while it is set, the keys belong to the draft and the filter stops
   * being what the input line means. Draft text is deliberately *not* on the
   * input line — that line is the filter, and a filter that is also the value
   * being chosen is two things in one keystroke.
   */
  const [pickerDraft, setPickerDraft] = createSignal<string | null>(null)
  /**
   * The picker's filter, which is the text on the input line.
   *
   * Not a second input: the prompt is the only place a user types, and a filter
   * box inside a panel would mean typing in one place to choose something in
   * another. So while a picker is open the input line *is* the query — which is
   * why opening one clears the input, and why the panel's title says so.
   */
  const [pickerQuery, setPickerQuery] = createSignal('')
  const [gone, setGone] = createSignal<number | null>(null)
  /**
   * The last copy attempt, and the frame it should disappear on.
   *
   * A signal plus a deadline rather than a boolean: "copied 3 lines" has to go
   * away on its own, or it sits in the status row forever pretending to be
   * current. The deadline is monotonic, so a re-render cannot resurrect it.
   */
  const [copy, setCopy] = createSignal<{ line: string; until: number } | null>(null)

  /**
   * Selection is a read gesture, so its result goes to the status row and
   * nowhere else. Putting it in the transcript would add every quoted fragment
   * to the conversation the agent sees, which is not what anyone means by
   * "copy this".
   */
  const onCopy = (report: CopyReport): void => {
    setCopy({ line: copyReportLine(report), until: Date.now() + 2500 })
  }

  /**
   * When the last Ctrl-C was, for the second-press-to-leave gesture.
   *
   * A deadline rather than a count, because a count cannot expire: two presses
   * an hour apart are two interruptions, not an instruction to quit. The window
   * is the length of a deliberate double-press and not much more.
   */
  let interruptedAt: number | null = null
  const CTRL_C_WINDOW_MS = 1500

  let input: TextareaRenderable | undefined
  let transcript: { scrollTop: number } | undefined
  let promptBlock: { height: number } | undefined


  /** Where replies to the host go; stdout is the screen, so never that. */
  const send = (message: ClientMessage): void => {
    const line = `${JSON.stringify(message)}\n`
    const fd = process.env.VAJRA_INPUT_FD
    if (fd) {
      writeSync(Number(fd), line)
      return
    }
    process.stdout.write(line)
  }

  const clearField = (): void => {
    setDraft('')
    input?.setText('')
  }

  const submit = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed === '') return
    clearField()
    send({ t: 'submit', value: trimmed })
  }

  /**
   * What the palette would show for a given buffer. Derived from the text, not
   * from a stored copy: a keypress and the keystroke before it can land in the
   * same tick, and answering Enter from a stale copy submits `/help` as a task
   * instead of running it.
   */
  /**
   * The line the user is on, and whether it is a command being typed.
   *
   * The last line, not the whole buffer — and that is the fix for a palette
   * that appeared not to work at all. Enter on an empty prompt submits nothing
   * but still leaves a newline in the textarea, so the buffer was "\n" and every
   * rule that asked about "the draft" was asking about a string with whitespace
   * in it: the palette stayed shut for the rest of the session, with no way for
   * the user to tell that pressing Enter had broken it. A command is always on
   * the current line, and the current line is what gets matched.
   */
  const commandQuery = (value: string): string | null => {
    const line = value.slice(value.lastIndexOf('\n') + 1)
    if (!line.startsWith('/')) return null
    const typed = line.slice(1)
    // A space ends the command: "/model x" is a sentence, not a command, and
    // the palette must not claim it.
    return /\s/.test(typed) ? null : typed
  }
  const hits = (value: string) => {
    const typed = commandQuery(value)
    return typed === null ? [] : matchCommands(commands(), typed)
  }
  const query = createMemo(() => commandQuery(draft()))
  const matches = createMemo(() => (query() === null ? [] : matchCommands(commands(), query() as string)))
  const paletteOpen = createMemo(() => matches().length > 0)

  /**
   * The picker's title: what it is, how much of it is left, what the input line
   * is for, and — when the list can be deleted from — the chord that does it.
   * The keys are named in the panel rather than left to be remembered, because
   * the alternative is a destructive shortcut nobody was told about.
   */
  /**
   * What the keys in the open list do, in the order you reach for them.
   *
   * The palette and a picker are the same panel over different rows, so they get
   * the same footer — and the footer grows a chord only when the list in front
   * of you can actually be deleted from.
   */
  /**
   * An empty draft is a placeholder in the muted grey, not a path in the accent:
   * a placeholder painted like a real value is a real value as far as a user is
   * concerned — they read it, and then wonder why the directory is a path to
   * nowhere. Once there is something typed it is cyan, the colour this screen
   * uses for the things that are chosen rather than reported.
   */
  const pickerDraftFg = createMemo(() =>
    (pickerDraft() || '') === '' ? theme.textMuted : theme.listSelected,
  )

  const pickerHint = createMemo(() => {
    // Enter is not named: it is the key every list in every program answers to,
    // and the row that fits on the line is the one naming the destructive chord.
    const parts = ['↑↓ move', 'type to filter']
    if (picker()?.deletable) parts.push('ctrl+d delete')
    parts.push('esc back')
    return parts.join('  ·  ')
  })

  const pickerTitle = createMemo(() => {
    const open = picker()
    if (!open) return ''
    // The rows on screen, not the rows the host sent: the client adds its own
    // type-a-path row, and a title reading "4 of 3" because two components
    // counted differently is worse than no count.
    const total = pickerOptions().length
    const shown = pickerMatches().length
    const count = shown === total ? `(${total})` : `(${shown} of ${total})`
    const typed = pickerQuery().trim()
    const filter = typed === '' ? 'type to filter' : `“${typed}”`
    return `${open.title}  ${count}  ·  ${filter}`
  })

  /**
   * The picker's options after the filter, best first.
   *
   * The search runs over the whole row — id, reasoning vocabulary, price,
   * everything the label says — so `free`, `opus` and `xhigh` all find
   * something, and a query that matches nothing is an empty list rather than
   * seventy-five rows with the answer buried somewhere in them.
   */
  /**
   * The rows of an open picker, including the client's own type-a-path row.
   *
   * Prepended here rather than sent by the host: it is a keyboard mode, not a
   * place, and a host that had to invent a placeholder path for it would be
   * inventing a directory that might exist.
   */
  const pickerOptions = createMemo(() => {
    const open = picker()
    if (!open) return []
    return open.editable ? [{ value: TYPE_A_PATH, label: TYPE_A_PATH_LABEL }, ...open.options] : open.options
  })

  const pickerMatches = createMemo(() => {
    const options = pickerOptions()
    const query = pickerQuery().trim()
    return query === '' ? options : fuzzyFilter(query, options, filterText)
  })

  /**
   * Keep the cursor on the *option* it was on, not on the index it had.
   *
   * The list is re-sorted by every keystroke, so an index would jump to an
   * unrelated row as the user typed — the same row number, a different
   * answer. Holding the option means the highlight follows what the cursor was
   * on when it survived the filter, and falls to the top when it did not.
   */
  const holdPickerRow = (query: string): void => {
    const open = picker()
    if (!open) return
    const after = query.trim() === '' ? open.options : fuzzyFilter(query.trim(), open.options, filterText)
    const current = open.options[pickerIdx()]
    if (current) {
      const at = after.findIndex(option => option.value === current.value)
      if (at !== -1) {
        setPickerIdx(at)
        return
      }
    }
    // The cursor's option is gone — the filter no longer has it — so the cursor
    // goes to the top, which is the best match for what was just typed. Clamping
    // the old index instead would land on an arbitrary row of a shorter list,
    // which is the same row number pointing at a different answer.
    setPickerIdx(0)
  }


  /**
   * The cursor cannot outlive the list.
   *
   * Filtering is what changes the list, and it happens on every keystroke: the
   * cursor was on row 2 of `/m` — model, models — and one more letter left one
   * row, so index 1 pointed past the end. Nothing highlighted, and Enter had no
   * row to run, which is the worst possible state for a control whose whole
   * purpose is to be pressed. Clamped here rather than at each use, because the
   * highlight has to be right too, not just the Enter.
   */
  createEffect(() => {
    const last = Math.max(0, matches().length - 1)
    if (paletteIdx() > last) setPaletteIdx(last)
    if (picker()) {
      const options = picker()?.options.length ?? 0
      const at = Math.min(pickerIdx(), Math.max(0, options - 1))
      if (at !== pickerIdx()) setPickerIdx(at)
    }
  })

  onMount(() => {
    // Select text, and it is on the clipboard. The renderer owns the mapping
    // from cells back to characters; this is the debounce and the one-line
    // report, both of which have to live somewhere that is not the transcript.
    const uninstall = installSelectionCopy(props.renderer, onCopy)
    // The report expires on a timer rather than on the next event: nothing else
    // happens when a copy lands, and a status line that only updates when the
    // agent speaks is a status line that lies about how long ago it spoke.
    const expiry = setInterval(() => {
      setCopy(current => (current && current.until <= Date.now() ? null : current))
    }, 250)

    let buffered = ''
    const handle = (message: ServerMessage): void => {
      if (message.t === 'state') setState(message.state)
      else if (message.t === 'commands') setCommands(message.commands)
      else if (message.t === 'pick') {
        setPicker({
          title: message.title,
          options: message.options,
          deletable: message.deletable === true,
          editable: message.editable === true,
        })
        // A picker opening is not a draft: the mode is entered from a row, so a
        // list that is re-sent after a rejected path starts as a list again.
        setPickerDraft(null)
        // The host may say where the cursor belongs; a list sorted by price and
        // name is not somewhere a user expects to land on row 0.
        setPickerIdx(Math.min(Math.max(0, message.initial ?? 0), Math.max(0, message.options.length - 1)))
        // The input is about to be the filter, so it cannot already hold a task.
        setPickerQuery('')
        clearField()
      } else if (message.t === 'clear') clearField()
      else if (message.t === 'exit') {
        setGone(message.code)
        clearInterval(expiry)
        uninstall()
        setTimeout(() => process.exit(message.code), 120)
      }
    }
    void (async () => {
      for await (const chunk of openFeed()) {
        buffered += chunk.toString()
        let nl = buffered.indexOf('\n')
        while (nl !== -1) {
          const line = buffered.slice(0, nl)
          buffered = buffered.slice(nl + 1)
          if (line.trim() !== '') {
            try {
              handle(JSON.parse(line) as ServerMessage)
            } catch {
              // A partial or foreign line is not worth crashing the screen for.
            }
          }
          nl = buffered.indexOf('\n')
        }
      }
    })()
    send({ t: 'ready', cols: dimensions().width, rows: dimensions().height })
  })

  // Follow the tail: a scrollbox scrolls natively, so we only say where.
  const scrollToEnd = (): void => {
    const node = transcript
    if (node) node.scrollTop = Number.MAX_SAFE_INTEGER
  }
  createMemo(() => {
    const entries = state()?.entries.length ?? 0
    const streaming = state()?.streaming ?? ''
    const thinking = state()?.thinking ?? ''
    queueMicrotask(scrollToEnd)
    return `${entries}:${streaming.length}:${thinking.length}`
  })

  useKeyboard((key: any) => {
    if (key.name === 'c' && key.ctrl) {
      key.preventDefault()
      // First press interrupts, second leaves. The count lives here rather than
      // in the host because the host cannot tell a second press from a first:
      // it only sees the messages, and the screen is what knows how long ago
      // the last one was.
      if (interruptedAt !== null && Date.now() - interruptedAt < CTRL_C_WINDOW_MS) {
        send({ t: 'signal', name: 'interrupt', force: true })
        interruptedAt = null
        return
      }
      interruptedAt = Date.now()
      send({ t: 'signal', name: 'interrupt' })
      return
    }
    // The reasoning level is a prompt concern, so it is a prompt key, sitting
    // where OpenCode's variant chip sits.
    if (key.name === 'r' && key.ctrl) {
      key.preventDefault()
      send({ t: 'slash', name: 'reasoning' })
      return
    }

    // A picker claims four keys and no more: up, down, enter, escape. Everything
    // else is the filter, so it has to reach the input line — including `j` and
    // `k`, which used to be down and up here and which is why a model called
    // "kimi-k3" could not be typed into the list that offered it.
    const open = picker()
    if (open) {
      // Drafting a value: every key belongs to the draft, because the list is
      // not what is being answered right now. Esc puts the list back rather
      // than closing the picker, because a mistyped path is worth correcting
      // without losing the recommendations.
      const draft = pickerDraft()
      if (draft !== null) {
        if (key.name === 'escape') {
          key.preventDefault()
          setPickerDraft(null)
          return
        }
        if (key.name === 'return') {
          key.preventDefault()
          if (draft.trim() === '') return
          setPicker(null)
          setPickerDraft(null)
          setPickerQuery('')
          clearField()
          send({ t: 'pick', value: draft.trim() })
          return
        }
        if (key.name === 'backspace') {
          key.preventDefault()
          setPickerDraft(d => (d ?? '').slice(0, -1))
          return
        }
        if (key.name === 'c' && key.ctrl) {
          key.preventDefault()
          setPicker(null)
          setPickerDraft(null)
          setPickerQuery('')
          clearField()
          send({ t: 'pick', value: null })
          return
        }
        // The character is `key.sequence`, not the component's `input` — that
        // name is the textarea renderable in this file, and concatenating it
        // types "[object Object]" into the path.
        // preventDefault, or the character also lands in the input line and
        // becomes a filter: the draft fills in *and* the list narrows, which is
        // two answers to one keystroke. In draft mode the input is not the
        // query, so it gets nothing.
        const typed = key.sequence ?? ''
        if (!key.ctrl && !key.meta && [...typed].length === 1 && typed >= ' ') {
          key.preventDefault()
          setPickerDraft(d => (d ?? '') + typed)
        }
        return
      }
      if (key.name === 'escape') {
        key.preventDefault()
        setPicker(null)
        setPickerQuery('')
        clearField()
        // The host is waiting on an answer. Closing a picker silently would
        // leave the command that opened it — `/reasoning`, `/model`, `/dir` —
        // hanging for the rest of the session, and the next `/reasoning` would
        // queue behind it.
        send({ t: 'pick', value: null })
        return
      }
      if (key.name === 'up' || key.name === 'down' || key.name === 'return') {
        key.preventDefault()
      }
      // Ctrl-D, not `d`: the input line is this list's filter, and a session id
      // is hex, so a bare `d` would delete a row while the user was typing the
      // id of the row they meant. A destructive action behind a chord can be
      // typed near without being triggered.
      if (key.name === 'd' && key.ctrl) {
        key.preventDefault()
        const chosen = pickerMatches()[pickerIdx()]
        if (chosen && open.deletable) send({ t: 'pick', value: chosen.value, action: 'delete' })
        return
      }
      if (key.name === 'up' || key.name === 'down') {
        const count = pickerMatches().length
        if (count === 0) return
        const step = key.name === 'up' ? -1 : 1
        setPickerIdx(i => (i + step + count) % count)
        return
      }
      if (key.name === 'return') {
        const chosen = pickerMatches()[pickerIdx()]
        // Nothing to choose is not a reason to close: the filter is still in the
        // input, and a user who typed a name with one letter wrong wants to
        // fix the letter, not to start over from the whole list.
        if (!chosen) return
        // The type-a-path row is a keyboard mode, not a value, so it does not
        // answer the host — it turns the keys into a draft and stays open.
        if (chosen.value === TYPE_A_PATH) {
          setPickerDraft('')
          return
        }
        setPicker(null)
        setPickerQuery('')
        clearField()
        send({ t: 'pick', value: chosen.value })
        return
      }
      // A printable key: let it through, and let the input's onContentChange
      // re-filter the list around it.
      return
    }

    const value = input?.plainText ?? ''
    const options = hits(value)

    if (options.length > 0) {
      // Arrows only. The palette sits on the input line, so every key it claims
      // is a letter the user was typing: `j` and `k` as "down" and "up" meant
      // that `/mj` silently typed `/m`, and the palette stayed open waiting for
      // a name that could never match. A picker has no text behind it and keeps
      // the vi keys; this one cannot.
      if (key.name === 'up') {
        key.preventDefault()
        setPaletteIdx(i => (i === 0 ? options.length - 1 : i - 1))
      } else if (key.name === 'down') {
        key.preventDefault()
        setPaletteIdx(i => (i === options.length - 1 ? 0 : i + 1))
      } else if (key.name === 'return') {
        // The cursor is clamped above, so there is always a row to run — and if
        // the list emptied between the keystroke and this handler, Enter falls
        // through to the submit path rather than swallowing a key the user can
        // see doing nothing.
        const chosen = options[Math.min(paletteIdx(), options.length - 1)]
        if (chosen) {
          key.preventDefault()
          clearField()
          setPaletteIdx(0)
          send({ t: 'slash', name: chosen.name })
          return
        }
      } else if (key.name === 'escape') {
        key.preventDefault()
        clearField()
        setPaletteIdx(0)
      }
    }

    if (key.name === 'return' && value.trim() !== '') {
      key.preventDefault()
      submit(value)
      return
    }
    if (key.name === 'return') {
      // An empty prompt has nothing to submit, so Enter must not do the one
      // thing it would otherwise do: grow the textarea by a line. Every stray
      // Enter — the reflexive one after a run ends — left a blank first line
      // that no rule about the draft could see past.
      key.preventDefault()
      return
    }
    if (key.name === 'escape' && draft() !== '') {
      key.preventDefault()
      clearField()
    }
  })

  return (
    <box
      style={{
        flexDirection: 'column',
        width: dimensions().width,
        height: dimensions().height,
        backgroundColor: theme.background,
      }}
    >
      <Show when={gone() !== null} fallback={<Show when={state()} fallback={<Connecting />}>{s => <Session state={s()} />}</Show>}>
        <box style={{ justifyContent: 'center', alignItems: 'center', flexGrow: 1 }}>
          <text content={`vajra exited (${gone()})`} fg={theme.textMuted} />
        </box>
      </Show>
    </box>
  )

  function Session(props: { state: UiState }) {
    const state = () => props.state
    const sidebarWidth = createMemo(() => (dimensions().width >= SIDEBAR_MIN_WIDTH ? SIDEBAR_WIDTH : 0))

    /**
     * The prompt's height, measured after each layout.
     *
     * Nothing lays out against it any more — the column is a fixed height, the
     * transcript flexes into what is left, and the prompt keeps its natural
     * height — but a picker does need to know it: the picker and the prompt are
     * siblings in the same column, so a list sized without regard for the
     * prompt's editor pushes the prompt off the bottom of the terminal, and the
     * screen looks complete with its input invisible.
     */
    const [promptHeight, setPromptHeight] = createSignal(0)
    const measure = (): void => {
      const height = promptBlock?.height ?? 0
      if (height !== promptHeight()) setPromptHeight(height)
    }
    createEffect(() => {
      state()
      // After layout, not during: the height is not known until Yoga has run.
      queueMicrotask(measure)
    })

    /**
     * The cells a panel row may use.
     *
     * The panel is the left column, inset by the column margins, with a one-cell
     * left rule and two cells of padding on each side — so this is the width a
     * row has to be cut to, and every row in every panel is cut to it.
     */
    /**
     * The panel's height, for the list it currently holds.
     *
     * Filtered, not total: a list of three rows that started as seventy-five
     * should shrink back down, or the panel keeps the height of its worst case
     * and the transcript loses the space for as long as the picker is open.
     */
    const panelCells = createMemo(
      () => Math.max(8, dimensions().width - sidebarWidth() - COLUMN_MARGIN * 2 - PANEL_CHROME_CELLS),
    )

    /** The entries the transcript draws: everything except the banner. */
    const transcriptEntries = createMemo(() => state().entries.filter(entry => entry.kind !== 'banner'))

    /**
     * The rows a list of `count` options may take, chrome included.
     *
     * One rule for the palette and the pickers, because they are the same
     * control in two places, and they failed the same way when they had
     * separate rules: an uncapped list is a list that pushes the prompt's meta
     * row, its rule and its status row off the bottom of a short terminal. The
     * prompt is the one thing that must never be the thing that is missing, so
     * a list gets what is left after the prompt and a few transcript rows —
     * and scrolls, rather than overruns.
     */
    const panelRows = (count: number): number => {
      if (count === 0) return 0
      const chrome = PICKER_CHROME_ROWS + PICKER_HINT_ROWS
      const spare = Math.max(0, dimensions().height - promptHeight() - MIN_TRANSCRIPT_ROWS)
      return Math.min(count, Math.max(3, spare - chrome)) + chrome
    }
    const pickerRows = createMemo(() => panelRows(pickerMatches().length))
    const paletteRows = createMemo(() => panelRows(matches().length))

    return (
      <>
        {/*
          Two full-height columns, and nothing crosses between them.

          The prompt used to be a sibling of this row, so it spanned the whole
          width and the sidebar stopped dead above it: a 42-cell column of dead
          space next to a full-width input, on a screen whose whole point is
          using its width. With the prompt inside the left column the division
          runs top to bottom — transcript and input on the left, the sidebar's
          own content and footer on the right — and the width is divided once
          instead of twice.

          The root has numbers for both dimensions, from useTerminalDimensions,
          because percentage sizing does not resolve against the renderer root;
          every height below is therefore a plain flex share of a known height,
          which is what lets the prompt keep its natural height and the
          transcript take the rest without either being measured.
        */}
        <box
          style={{
            flexDirection: 'row',
            width: dimensions().width,
            height: dimensions().height,
            minHeight: 0,
            backgroundColor: theme.background,
          }}
        >
          {/* The left column: picker, transcript, prompt — inset by a cell on
              each side, so the `╹` rules and the transcript's gutter are not
              welded to the edge of the terminal. The width takes the margins
              off again, because a fixed-width box plus margins in Yoga is a box
              that overflows its row and pushes the sidebar off the screen. */}
          <box
            style={{
              flexDirection: 'column',
              flexShrink: 0,
              height: dimensions().height,
              minHeight: 0,
              marginLeft: COLUMN_MARGIN,
              marginRight: COLUMN_MARGIN,
              width: dimensions().width - sidebarWidth() - COLUMN_MARGIN * 2,
            }}
          >
            {/* The transcript: two cells of gutter, one of gap, one of air. */}
            <box
              style={{
                flexGrow: 1,
                minHeight: 3,
                paddingBottom: 1,
                paddingLeft: 2,
                paddingRight: 2,
                gap: 1,
              }}
            >
            <scrollbox
              ref={(r: any) => (transcript = r)}
              style={{ flexGrow: 1 }}
              stickyScroll={true}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                // OpenCode's scrollbar is off unless `showScrollbar` is set, so
                // the transcript has no bar by default. The track stays
                // configured: turning it on is then one flag.
                visible: false,
                trackOptions: { backgroundColor: theme.backgroundElement, foregroundColor: theme.border },
              } as any}
            >
              <box style={{ height: 1 }} />
              {/* The banner entry is not drawn. `vajra v0.0.1` is in the
                  sidebar's footer, where a status belongs; the transcript is for
                  the conversation, and a build number is not part of it. */}
              <For each={transcriptEntries()}>
                {(entry, i) => <EntryRow entry={entry} first={i() === 0} />}
              </For>
              <Show when={state().thinking !== ''}>
                {/* OpenCode's ReasoningPart: a header that says what is being
                    thought, then the body as markdown at the thinking opacity. */}
                <box style={{ paddingLeft: 3, marginTop: 1, flexShrink: 0, flexDirection: 'column' }}>
                  <box style={{ flexDirection: 'row' }}>
                    <spinner frames={spinnerFrames} color={thinkingColor()} interval={40} />
                    <text content={` Thinking: ${oneLine(state().thinking)}`} fg={thinkingColor()} />
                  </box>
                  <box style={{ marginTop: 1, paddingLeft: 2 }}>
                    <code
                      filetype="markdown"
                      drawUnstyledText={false}
                      streaming={true}
                      syntaxStyle={syntax}
                      content={oneLine(state().thinking)}
                      fg={theme.textMuted}
                    />
                  </box>
                </box>
              </Show>
              <Show when={state().streaming !== ''}>
                <box style={{ paddingLeft: 3, marginTop: 1, flexShrink: 0 }}>
                  <markdown
                    syntaxStyle={syntax}
                    streaming={true}
                    internalBlockMode="top-level"
                    tableOptions={{ style: 'grid' }}
                    fg={theme.markdownText}
                    bg={theme.background}
                    content={state().streaming.trim()}
                  />
                </box>
              </Show>
            </scrollbox>
            </box>

            {/*
              The lists live here, between the transcript and the input — not at
              the top of the column, where a panel of options floated above the
              conversation it was about. A list you are choosing from belongs
              next to the thing you are choosing it for, and the input is what
              the next keystroke goes into.
            */}
            <Show when={picker()}>
              {open => (
                <Panel title={pickerTitle()}>
                  {/* The model picker has as many rows as the gateway serves, and a
                      panel that renders all of them runs off the top of the screen:
                      the last rows are drawn over the first ones, so the list is
                      unreadable exactly when it is longest. A fixed-height scrollbox
                      that follows the cursor is the only arrangement that works for
                      both a three-option directory picker and a seventy-five-model
                      catalog. */}
                  {/*
                    The draft, while a value is being typed.

                    It is a row of its own rather than a field in the panel: the
                    prompt is the only place this program takes typing, and a
                    second input inside a panel means typing in one place to
                    answer something in another. So the draft sits where the
                    input line would be, in the same accent, and the keys go to
                    it instead of the filter.
                  */}
                  {/* One text element, not a row of three: a <Show> whose child
                      is a multi-child <box> hands the transform's children array
                      to the renderer, and the row comes out as `[object
                      Object]`. The colour carries the state instead — muted while
                      there is nothing typed, cyan once there is, the same accent
                      as the role and the dial above. */}
                  <Show when={pickerDraft() !== null}>
                    <text
                      content={`✎ ${ellipsis(pickerDraft() || PATH_PLACEHOLDER, panelCells() - 6)}█`}
                      fg={pickerDraftFg()}
                      style={{ flexShrink: 0, width: '100%' }}
                    />
                  </Show>
                  <Show
                    when={pickerMatches().length > 0}
                    fallback={
                      /* An empty list with nothing in it reads as a broken
                         picker; one line saying so is the difference between
                         "nothing matches" and "this is broken". */
                      <text
                        content={`no match for “${pickerQuery().trim()}”`}
                        fg={theme.listOption}
                        style={{ flexShrink: 0, width: '100%' }}
                      />
                    }
                  >
                    <PickerList
                      options={pickerMatches()}
                      selected={pickerIdx()}
                      height={pickerRows() - PICKER_CHROME_ROWS - PICKER_HINT_ROWS - (pickerDraft() === null ? 0 : 1)}
                      cells={panelCells()}
                    />
                  </Show>
                  {/*
                    The keys on their own row, muted. They were in the title,
                    and a title long enough to name them wraps — which turns one
                    line of instructions into two, and puts half of them under
                    the sidebar.
                  */}
                  <text
                    content={ellipsis(pickerHint(), panelCells() - 4)}
                    fg={theme.listOption}
                    style={{ flexShrink: 0, width: '100%' }}
                  />
                </Panel>
              )}
            </Show>

            <Show when={paletteOpen() && !picker()}>
              <Panel>
                {/* The palette is the picker's list with a different source: one
                    row per command, each cut to the panel's width, scrolling and
                    following the cursor when the command set is taller than the
                    terminal. It used to be a <For> of <text>s with no width, so
                    every summary wrapped onto a line of its own outside the
                    rule — seven commands in twenty rows. */}
                <PickerList
                  options={matches().map(command => ({
                    value: command.name,
                    label: `/${command.name}  ${command.summary}`,
                  }))}
                  selected={paletteIdx()}
                  height={paletteRows() - PICKER_CHROME_ROWS - PICKER_HINT_ROWS}
                  cells={panelCells()}
                />
                <text
                  content={ellipsis(pickerHint(), panelCells() - 4)}
                  fg={theme.listOption}
                  style={{ flexShrink: 0, width: '100%' }}
                />
              </Panel>
            </Show>

            {/* ── the prompt, transcribed from component/prompt/index.tsx ────── */}
            <box
              ref={(r: any) => {
                promptBlock = r
                queueMicrotask(measure)
              }}
              style={{ width: '100%', flexShrink: 0 }}
            >
          <box
            style={{
              width: '100%',
              flexShrink: 0,
              // The prompt sizes itself to its content: without this Yoga hands
              // the block a height computed before the meta row existed, and the
              // model and reasoning line is clipped out of existence — a row of
              // space, laid out, with nothing painted in it.
              alignSelf: 'flex-start',
              border: ['left'],
              borderColor: theme.border,
              customBorderChars: PROMPT_BLOCK,
            }}
          >
            <box
              style={{
                paddingLeft: 2,
                paddingRight: 2,
                paddingTop: 1,
                flexShrink: 0,
                backgroundColor: theme.backgroundElement,
                width: '100%',
              }}
            >
              <textarea
                ref={(r: TextareaRenderable) => (input = r)}
                focused
                width="100%"
                placeholder={state().prompt?.label ?? ''}
                placeholderColor={theme.textMuted}
                textColor={theme.text}
                focusedTextColor={theme.text}
                focusedBackgroundColor={theme.backgroundElement}
                cursorColor={theme.text}
                minHeight={1}
                maxHeight={Math.max(6, Math.floor(dimensions().height / 3))}
                onContentChange={() => {
                  const text = input?.plainText ?? ''
                  setDraft(text)
                  // While a picker is open this line is the filter, not a task.
                  // `holdPickerRow` rather than a reset to zero: the list is
                  // re-sorted by every keystroke, so the cursor has to follow the
                  // option it was on rather than the row number.
                  if (picker()) {
                    setPickerQuery(text)
                    holdPickerRow(text)
                  }
                }}
                onSubmit={() => submit(input?.plainText ?? '')}
              />
              <box
                style={{ flexDirection: 'row', flexShrink: 0, paddingTop: 1, gap: 1, justifyContent: 'space-between' }}
              >
                {/* What you are talking to, and nothing else: the role running
                    it, the model, and the gateway that serves it. The role used
                    to be absent on the grounds that there was no choice of
                    agent — one agent, always the same, so naming it on every
                    prompt was a label for something the user could not change.
                    There are three roles now and each can be on its own model
                    (/config), so a bare model id is ambiguous: it is the
                    developer's, and the one that the context meter and the
                    reasoning dial above are describing.

                    Always shown, run or not. The sidebar no longer repeats the
                    model id, so this row is the only place it appears, and a
                    meta row that empties itself while the agent works leaves the
                    reasoning chip on the right addressing nobody. */}
                <box style={{ flexDirection: 'row', gap: 1 }}>
                  {/* The same cyan as the list cursor: it is the one thing in
                      the row that is a name rather than a fact about a model. */}
                  <text content="developer" fg={theme.listSelected} style={{ flexShrink: 0 }} />
                  <text content={bareModel(state().model)} fg={theme.text} style={{ flexShrink: 0 }} />
                  <text content={providerOf(state().model)} fg={theme.textMuted} />
                </box>
                {/* How hard it is thinking, in the slot OpenCode puts a variant
                    in: the right end of the meta row, a muted separator and the
                    level beside it. Cyan to match the role, so the two things on
                    this row that are *chosen* read as chosen and the model id
                    does not.

                    `off` is shown rather than hidden. The old reason to hide it
                    was that nobody asked for an "off"; but a dial the user just
                    turned and cannot see the result of is a dial they will turn
                    again, and for a model that cannot reason at all, "off" is
                    the answer rather than the absence of one. */}
                <box style={{ flexDirection: 'row', gap: 1, alignItems: 'center', flexShrink: 0 }}>
                  <text content="·" fg={theme.textMuted} />
                  <text fg={theme.listSelected} style={{ flexShrink: 0 }}>
                    <strong>{state().reasoning}</strong>
                  </text>
                </box>
              </box>
            </box>
          </box>

          {/* The closing rule: a `╹` in the gutter, then a `▀` across the panel. */}
          <box style={{ height: 1, border: ['left'], borderColor: theme.border, customBorderChars: GUTTER_TICK }}>
            <box
              style={{ height: 1, border: ['bottom'], borderColor: theme.backgroundElement, customBorderChars: HALF_RULE }}
            />
          </box>

          {/* The status row: the spinner and what it is doing, or the directory
              when nothing is; usage on the right once there is any, and the key
              hints until then. */}
          <box style={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
            <Show
              when={state().prompt === null}
              fallback={
                <box style={{ marginLeft: 1 }}>
                  <text
                    content={shortPath(state().projectDir, Math.floor((dimensions().width - sidebarWidth()) / 2))}
                    fg={theme.textMuted}
                  />
                </box>
              }
            >
              <box style={{ flexDirection: 'row', gap: 1 }}>
                <box style={{ marginLeft: 1 }}>
                  <spinner frames={spinnerFrames} color={spinnerColors} interval={40} />
                </box>
                <text content={state().thinking !== '' ? oneLine(state().thinking) : 'working'} fg={theme.text} />
              </box>
            </Show>
            <Show when={state().prompt !== null}>
              <box style={{ gap: 2, flexDirection: 'row' }}>
                {/* A copy report takes the usage slot for as long as it is
                    true. It is the newest thing that happened to the user, and
                    the meter is a number they can read again any time.

                    With neither, the slot is empty. It used to hold
                    "ctrl+r reasoning levels" — a keybinding advertisement for
                    a control the palette already lists, in the one place on the
                    screen that is meant for what just happened. */}
                <Show
                  when={copy()}
                  fallback={
                    <Show when={state().usage.calls > 0}>
                      <text content={usageLine(state())} fg={theme.textMuted} style={{ wrapMode: 'none' }} />
                    </Show>
                  }
                >
                  {report => <text content={report().line} fg={theme.success} style={{ wrapMode: 'none' }} />}
                </Show>
                <text fg={theme.text}>
                  / <span style={{ fg: theme.textMuted }}>commands</span>
                </text>
              </box>
            </Show>
          </box>
            </box>
            </box>

          {/* The right column: the sidebar, all the way down, with its footer
              at the bottom of the screen rather than level with the input. */}
          <Show when={sidebarWidth() > 0}>
            <Sidebar state={state()} width={sidebarWidth()} height={dimensions().height} />
          </Show>
        </box>
      </>
    )
  }

  /**
   * A picker's options, in a box of fixed height that follows the cursor.
   *
   * The height is a function of the terminal rather than a constant: a short
   * terminal should not spend two thirds of its height on a list, and a tall
   * one should not scroll three visible rows at a time.
   */
  function PickerList(props: { options: { value: string; label: string }[]; selected: number; height: number; cells: number }) {
    let list: { scrollTop: number } | undefined
    // A visible scrollbar takes a cell off the right of every row, and a row cut
    // to the full width is a row the track is drawn on top of — the ellipsis
    // disappears under a block of scrollbar, which reads as a truncated label
    // that was never truncated on purpose.
    const scrolls = () => props.options.length > props.height
    // One cell of slack for the track, so the ellipsis is never the cell the
    // scrollbar paints on.
    const labelCells = () => props.cells - CURSOR_MARKER.length - (scrolls() ? 2 : 0)
    // Keep the cursor in view. Assigning scrollTop on every index change is the
    // whole scroll behaviour: no animation, no scroll events, and the list is
    // exactly where the keypress left it.
    createEffect(() => {
      const node = list
      if (!node) return
      const at = props.selected
      if (at < node.scrollTop) node.scrollTop = at
      else if (at >= node.scrollTop + props.height) node.scrollTop = at - props.height + 1
    })
    return (
      <scrollbox
        ref={(r: any) => (list = r)}
        style={{ height: props.height, flexShrink: 0 }}
        verticalScrollbarOptions={{
          paddingLeft: 1,
          visible: scrolls(),
          trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.borderActive },
        } as any}
      >
        {/* Cut, not wrapped: a picker row is one line of facts about one model,
            and a wrapped one puts half a model's context window on a row with
            no rule and no cursor. */}
        <For each={props.options}>
          {(option, i) => (
            <text
              content={`${i() === props.selected ? CURSOR_MARKER : '  '}${ellipsis(option.label, labelCells())}`}
              fg={i() === props.selected ? theme.listSelected : theme.listOption}
              style={{ flexShrink: 0, width: '100%' }}
            />
          )}
        </For>
      </scrollbox>
    )
  }

  /** A left-ruled, filled block with a title — the shape every panel uses. */
  function Panel(props: { title?: string; children?: unknown }) {
    return (
      <box
        style={{ width: '100%', flexShrink: 0, border: ['left'], borderColor: theme.border, customBorderChars: PROMPT_BLOCK }}
      >
        <box
          style={{
            paddingLeft: 2,
            paddingRight: 2,
            paddingTop: 1,
            paddingBottom: 1,
            backgroundColor: theme.backgroundPanel,
            width: '100%',
          }}
        >
          <Show when={props.title}>
            <text content={props.title as string} fg={theme.textMuted} />
          </Show>
          {props.children as never}
        </box>
      </box>
    )
  }
}

function Connecting() {
  return (
    <box style={{ justifyContent: 'center', alignItems: 'center', flexGrow: 1 }}>
      <text content="connecting…" fg={theme.textMuted} />
    </box>
  )
}

/** The context window in tokens, as a compact `1.0M` / `262k`. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return String(n)
}

/** USD per million tokens, or the word the pricing page would use. */
function formatPrice(cost: { input: number; output: number }): string {
  if (cost.input === 0 && cost.output === 0) return 'free'
  return `$${cost.input}/$${cost.output} per Mtok`
}

/** What the current model can do, as reported by the catalog. */
function ModelFacts(props: { info: NonNullable<UiState['modelInfo']> }) {
  const info = () => props.info
  const reasoning = createMemo(() => {
    const model = info()
    if (!model.reasoning) return 'no reasoning'
    if (model.reasoningMode === 'effort') return model.levels.slice(1).join('/') || 'effort'
    return model.reasoningMode
  })
  const status = createMemo(() => {
    const model = info()
    if (model.status === 'available') return '● available'
    if (model.status === 'unavailable') return '○ not served here'
    return '? status unknown'
  })
  return (
    <box>
      <text fg={theme.text}>
        <b>Model</b>
      </text>
      <text content={`${info().name}`} fg={theme.textMuted} />
      <text content={`${formatTokens(info().context)} ctx · ${reasoning()}`} fg={theme.textMuted} />
      <text content={formatPrice(info().cost)} fg={theme.textMuted} />
      <text content={status()} fg={info().status === 'available' ? theme.success : info().status === 'unavailable' ? theme.warning : theme.textMuted} />
    </box>
  )
}

/** The honest one-liner for a model the catalog cannot describe. */
function UnknownModel() {
  return (
    <box>
      <text fg={theme.text}>
        <b>Model</b>
      </text>
      <text content="facts unknown — catalog not fetched" fg={theme.textMuted} />
    </box>
  )
}

/**
 * The sidebar, transcribed from `routes/session/sidebar.tsx`.
 *
 * It is a *panel*, not a column: a filled `backgroundPanel` box, 42 cells wide,
 * padded one above and below and two either side, with its own scrollbox and a
 * visible scrollbar. Sections are bold `theme.text` headers over muted lines,
 * exactly as their Todo and Context plugins render them, and the directory sits
 * in a footer under a `paddingTop 1` gap.
 */
function Sidebar(props: { state: UiState; width: number; height: number }) {
  const state = () => props.state
  const contextLimit = createMemo(() => state().modelInfo?.context ?? UNKNOWN_CONTEXT_LIMIT)
  const [todoOpen, setTodoOpen] = createSignal(true)
  // Padding either side, the content gutter, and the three cells a status
  // bracket takes. A row that overflows wraps, and a wrapped status row puts
  // its continuation under the bracket instead of under the text.
  const inner = createMemo(() => Math.max(8, props.width - 9))

  return (
    <box
      style={{
        backgroundColor: theme.backgroundPanel,
        width: props.width,
        // The full height of the column, not "whatever the row above gave it":
        // the sidebar is a column of the screen, so its footer belongs on the
        // last row of the terminal rather than level with the input.
        height: props.height,
        flexShrink: 0,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2,
      }}
    >
      <scrollbox
        style={{ flexGrow: 1 }}
        verticalScrollbarOptions={{
          // The sidebar's content is short and mostly fixed; a bar here is
          // noise, and OpenCode's does not draw one either.
          visible: false,
          trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
        } as any}
      >
        <box style={{ flexShrink: 0, gap: 1, paddingRight: 1 }}>
          {/* No model-and-status header. The Model section two blocks down says
              what the model is, the status row under the prompt says whether
              anything is running, and a third copy of the model id at the top of
              a 42-cell column is the line the eye lands on first and reads
              last. */}

          {/* Their Context plugin: a bold header, then one muted line per fact.
              The denominator is the model's own window, so a 1M-context model
              and a 128k one are not both measured against 200k. */}
          <box>
            <text fg={theme.text}>
              <b>Context</b>
            </text>
            <text content={`${state().usage.lastPromptTokens.toLocaleString()} tokens`} fg={theme.textMuted} />
            <text
              content={`${Math.min(100, Math.round((state().usage.lastPromptTokens / contextLimit()) * 100))}% of ${formatTokens(contextLimit())}`}
              fg={theme.textMuted}
            />
          </box>

          {/* The model, as the catalog describes it: what it can do, what it
              costs, and whether the gateway is serving it to this key right
              now. Every line is conditional — a model the catalog has never
              heard of shows one line saying so, not six blank ones. */}
          <Show when={state().modelInfo} fallback={<UnknownModel />}>
            {info => <ModelFacts info={info()} />}
          </Show>

          {/* Their Todo plugin: a collapsible header once the list is long, and
              the bracket status rows from component/todo-item.tsx. */}
          <Show when={state().tasks.length > 0}>
            <box>
              <box style={{ flexDirection: 'row', gap: 1 }}>
                <Show when={state().tasks.length > 2}>
                  <text content={todoOpen() ? '▼' : '▶'} fg={theme.text} />
                </Show>
                <text fg={theme.text}>
                  <b>Tasks</b>
                </text>
              </box>
              <Show when={state().tasks.length <= 2 || todoOpen()}>
                <For each={state().tasks}>
                  {task => (
                    <box style={{ flexDirection: 'row', gap: 0 }}>
                      <text
                        content={`[${task.status === 'done' ? '✓' : task.status === 'running' ? '•' : ' '}] `}
                        fg={task.status === 'running' ? theme.warning : theme.textMuted}
                        style={{ flexShrink: 0 }}
                      />
                      <text
                        content={oneLine(`${task.title}${task.activity ? ` ${task.activity.tool} ${task.activity.summary}` : ''}`).slice(0, inner())}
                        fg={task.status === 'running' ? theme.warning : theme.textMuted}
                        style={{ flexGrow: 1 }}
                      />
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>
        </box>
      </scrollbox>

      {/* The footer is the version, and it is the only thing down here.
          `vajra v0.0.1` used to be the first line of the transcript, which put
          a build number above the first thing the user came to read and pushed
          it a screen away from the bottom-left corner where a status belongs.
          The directory went with it: the status row under the prompt already
          carries it, and two copies of a path is one too many. */}
      <box style={{ flexShrink: 0, gap: 1, paddingTop: 1 }}>
        <text fg={theme.textMuted} content={`vajra v${state().version}`} />
      </box>
    </box>
  )
}

function EntryRow(props: { entry: Entry; first: boolean }) {
  const entry = () => props.entry
  const text = () => (entry() as { text: string }).text

  /**
   * One node per entry kind.
   *
   * This began as a chain of `<Show>`s, one per kind, and rendered almost
   * nothing: a `<Show>` inside a box that returns several elements becomes a
   * fragment, and a fragment's children are not laid out by the flex parent —
   * they go side by side, or nowhere at all. A memo returning exactly one
   * element has no such gap, and it reads as the switch it is.
   */
  const row = createMemo(() => {
    const current = entry()
    switch (current.kind) {
      case 'blank':
        return <box style={{ height: 1 }} />
      case 'user':
        // User messages are blocks, exactly like OpenCode's: left rule, `╹`
        // tick, and a filled panel inset by two cells.
        return (
          <box
            style={{
              flexShrink: 0,
              border: ['left'],
              borderColor: theme.border,
              customBorderChars: PROMPT_BLOCK,
              marginTop: props.first ? 0 : 1,
            }}
          >
            <box
              style={{
                paddingTop: 1,
                paddingBottom: 1,
                paddingLeft: 2,
                backgroundColor: theme.backgroundPanel,
                flexShrink: 0,
              }}
            >
              <text content={text()} fg={theme.text} />
            </box>
          </box>
        )
      case 'assistant':
        // OpenCode renders answers as markdown with top-level block mode, so a
        // fenced block does not swallow the paragraphs around it.
        return (
          <box style={{ paddingLeft: 3, marginTop: 1, flexShrink: 0 }}>
            <markdown
              syntaxStyle={syntax}
              streaming={true}
              internalBlockMode="top-level"
              tableOptions={{ style: 'grid' }}
              fg={theme.markdownText}
              bg={theme.background}
              content={text().trim()}
            />
          </box>
        )
      case 'banner':
        return <text content={`vajra v${(current as { version: string }).version}`} fg={theme.textMuted} />
      case 'info':
        // The common case, and the one a missing case silently eats: it falls
        // through and the line vanishes from the transcript.
        return (
          <box style={{ flexDirection: 'row', paddingLeft: 3 }}>
            <text content={text()} fg={theme.textMuted} />
          </box>
        )
      case 'error':
        return (
          <box style={{ flexDirection: 'row', paddingLeft: 3 }}>
            <text content={text()} fg={theme.error} />
          </box>
        )
      case 'warning':
        return (
          <box style={{ flexDirection: 'row', paddingLeft: 3 }}>
            <text content={text()} fg={theme.warning} />
          </box>
        )
      case 'success':
        return (
          <box style={{ flexDirection: 'row', paddingLeft: 3 }}>
            <text content={text()} fg={theme.success} />
          </box>
        )
      case 'decision':
        return (
          <box style={{ flexDirection: 'row', paddingLeft: 3 }}>
            <text content={text()} fg={theme.secondary} />
          </box>
        )
      case 'plan':
        return (
          <box style={{ flexDirection: 'column', paddingLeft: 3 }}>
            <text content={(current as { title: string }).title} fg={theme.primary} />
            <For each={(current as { steps: string[] }).steps}>
              {(step, i) => <text content={`${i() + 1}. ${step}`} fg={theme.textMuted} />}
            </For>
          </box>
        )
      case 'tool': {
        // OpenCode's inline tool row: a two-cell icon column, then the label,
        // then the argument. While it runs the icon is a spinner, and a call
        // that has not started yet is a tilde rather than a status glyph — a
        // row that has not begun should not look like one that has failed.
        const failed = current.status === 'failed'
        const color = () => (failed ? theme.error : current.status === 'ok' ? theme.textMuted : theme.warning)
        const label = `${current.tool} ${oneLine(current.summary)}`
        return (
          <box style={{ paddingLeft: 3, flexShrink: 0 }}>
            <Show
              when={current.status !== 'running'}
              fallback={
                <box style={{ flexDirection: 'row' }}>
                  <spinner frames={spinnerFrames} color={color()} interval={40} />
                  <text content={` ${label}`} fg={color()} />
                </box>
              }
            >
              <box style={{ flexDirection: 'row' }}>
                <text content={failed ? '✗' : '✓'} fg={color()} style={{ width: INLINE_TOOL_ICON_WIDTH }} />
                <text content={` ${label}`} fg={color()} style={{ flexGrow: 1 }} />
              </box>
            </Show>
          </box>
        )
      }
      default:
        return <box style={{ height: 1 }} />
    }
  })

  return row() as unknown as JSX.Element
}

/**
 * Raw mode, set here rather than trusted to the renderer.
 *
 * The renderer decides by asking its stdin, and stdin is a tty here — but the
 * mode was still not being set, and the symptom is a prompt that looks alive
 * and silently drops everything: in cooked mode the line discipline echoes each
 * keystroke into the frame and withholds it from the reader until Enter, so the
 * text appears on screen and never reaches the buffer.
 */
const stdin = process.stdin as unknown as { isTTY?: boolean; isRaw?: boolean; setRawMode?: (on: boolean) => void }
const wasRaw = Boolean(stdin.isRaw)
if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true)
process.on('exit', () => {
  try {
    stdin.setRawMode?.(wasRaw)
  } catch {
    // The terminal is going away regardless.
  }
})

/**
 * `useMouse` is what turns on terminal mouse reporting, and with it the
 * renderer's own selection: a drag starts a `Selection`, the selection walks the
 * renderables it covers, and `getSelectedText()` reassembles the text. Wheel
 * scrolling and edge auto-scroll come from the same switch, because the scroll
 * boxes already handle scroll events.
 */
const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true })
await render(() => <App renderer={renderer} />, renderer)
