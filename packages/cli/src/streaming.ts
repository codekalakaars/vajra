import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import type { AgentEvent, AgentLabel } from './session/ui.js'

function readPackageVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url))
    const pkgPath = resolve(dir, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const terminalWidth = (): number => {
  const cols = process.stdout.columns
  return typeof cols === 'number' && cols > 20 ? cols : 80
}

let markedInstance: Marked | null = null

function getMarked(): Marked {
  if (!markedInstance) {
    const ext = markedTerminal({
      reflowText: true,
      width: terminalWidth(),
    })
    // marked-terminal's text renderer returns token.text as-is and skips
    // nested inline tokens (strong/em/codespan). That leaves **bold** inside
    // list items. Walk nested tokens via parseInline when present.
    const renderer = ext.renderer as Record<string, unknown> | undefined
    const originalText = renderer?.text as
      | ((this: unknown, token: unknown) => string | false)
      | undefined
    if (renderer) {
      renderer.text = function textWithInline(
        this: { parser?: { parseInline(tokens: unknown[]): string } },
        token: unknown,
      ): string | false {
        const tok = token as
          | { tokens?: unknown[]; text?: string }
          | string
          | null
          | undefined
        if (
          tok &&
          typeof tok === 'object' &&
          Array.isArray(tok.tokens) &&
          tok.tokens.length > 0 &&
          this.parser?.parseInline
        ) {
          return this.parser.parseInline(tok.tokens)
        }
        if (originalText) return originalText.call(this, token)
        if (typeof tok === 'string') return tok
        if (tok && typeof tok === 'object' && typeof tok.text === 'string') return tok.text
        return ''
      }
    }
    markedInstance = new Marked(ext)
  }
  return markedInstance
}

/** Render markdown for the terminal (ANSI colors + wrap). Falls back to raw text. */
export function renderMarkdown(markdown: string): string {
  const source = markdown.replace(/\r\n/g, '\n')
  if (!source.trim()) return source
  try {
    const result = getMarked().parse(source)
    const text = typeof result === 'string' ? result : String(result)
    return text.endsWith('\n') ? text : text + '\n'
  } catch {
    return source.endsWith('\n') ? source : source + '\n'
  }
}

export interface PlanTaskView {
  title: string
  type: string
  timeoutSeconds?: number
  writeFile?: string[]
  validation?: string[]
  dependsOn?: string[]
}

/**
 * Pure plan formatting shared by CLI (ANSI in planSummary) and TUI.
 * Returns plain lines: heading, blank lines, one line per task + aux lines.
 */
export function planSummaryLines(plan: { tasks: PlanTaskView[] }): string[] {
  const lines: string[] = ['', '📋 Plan:', '']
  plan.tasks.forEach((task, i) => {
    const timeout = task.timeoutSeconds ? ` (${task.timeoutSeconds}s)` : ''
    lines.push(`  ${i + 1}. ${task.title} [${task.type}]${timeout}`)
    if (task.writeFile && task.writeFile.length > 0) {
      lines.push(`      writes: ${task.writeFile.join(', ')}`)
    }
    if (task.validation && task.validation.length > 0) {
      lines.push(`      validation: ${task.validation.join(' && ')}`)
    }
    if (task.dependsOn && task.dependsOn.length > 0) {
      lines.push(`      depends on: ${task.dependsOn.join(', ')}`)
    }
  })
  lines.push('')
  return lines
}

interface ActiveAgent {
  label: string
  since: number
  note: string
}

export class TerminalStreamer {
  private buffer = ''
  private isThinking = false
  private readonly useSpinner: boolean
  /** Outstanding work, keyed by agent — the live status line's contents. */
  private active = new Map<string, ActiveAgent>()
  private statusDrawn = false
  private quiet: boolean

  constructor(
    private verbose = false,
    private version = readPackageVersion(),
    quiet = false,
  ) {
    this.useSpinner = Boolean(process.stdout.isTTY)
    this.quiet = quiet
  }

  onTextDelta(text: string): void {
    this.buffer += text
    // Streamed text is not printed until finishLine(); without a status entry
    // the screen would look dead, so fall back to a generic one.
    if (this.active.size === 0) {
      this.active.set('__text', { label: 'working', since: Date.now(), note: '' })
    }
    this.drawStatus()
  }

  onThinkingDelta(text: string): void {
    if (this.verbose) {
      if (!this.isThinking) {
        this.stopSpinner()
        process.stderr.write('\x1b[90m[thinking] ')
        this.isThinking = true
      }
      process.stderr.write(text)
    }
  }

  /** Flush buffered assistant text as rendered markdown. */
  finishLine(): void {
    this.clearStatus()
    if (this.isThinking) {
      process.stderr.write('\x1b[0m\n')
      this.isThinking = false
    }
    if (this.buffer.length > 0) {
      const rendered = renderMarkdown(this.buffer)
      process.stdout.write(rendered)
      this.buffer = ''
    }
    this.drawStatus()
  }

  /** Drop any unflushed buffer without printing (error paths). */
  discardBuffer(): void {
    this.clearStatus()
    this.buffer = ''
    if (this.isThinking) {
      process.stderr.write('\x1b[0m\n')
      this.isThinking = false
    }
    this.drawStatus()
  }

  // --- sub-task activity ------------------------------------------------

  private key(agent: AgentLabel): string {
    return agent.taskId ?? agent.role
  }

  private label(agent: AgentLabel): string {
    return agent.taskId ? `[${agent.taskId}]` : agent.role
  }

  /** Tool lines read `[task] → tool  summary` — the task first, so an
   *  interleaved stream from four workers stays attributable at a glance. */
  private toolPrefix(agent: AgentLabel): string {
    return agent.taskId ? `  ${this.label(agent)} ` : '  '
  }

  /**
   * The live status line. One line, rewritten in place, listing every agent
   * with outstanding work plus its elapsed time. Events alone leave the screen
   * silent through a 40-second provider call; this is what moves.
   */
  private drawStatus(): void {
    if (!this.useSpinner || this.active.size === 0) return
    const now = Date.now()
    const parts = [...this.active.values()].map(
      a => `${a.label} ${((now - a.since) / 1000).toFixed(1)}s${a.note ? ` ${a.note}` : ''}`,
    )
    process.stderr.write(`\r\x1b[2K\x1b[90m◇ ${parts.join(' · ')}\x1b[0m`)
    this.statusDrawn = true
  }

  private clearStatus(): void {
    if (!this.statusDrawn) return
    process.stderr.write('\r\x1b[2K')
    this.statusDrawn = false
  }

  /** Write a real line to stdout without leaving the status line underneath. */
  private writeLine(text: string): void {
    this.clearStatus()
    // Piped output must be clean: no cursor tricks, and no SGR either — a log
    // full of escape bytes is as unreadable as one full of spinner frames.
    const line = this.colorize ? text : text.replace(/\x1b\[[0-9;]*m/g, '')
    process.stdout.write(`${line}\n`)
    this.drawStatus()
  }

  /** Colour only where a terminal can render it, or when explicitly forced. */
  private get colorize(): boolean {
    return this.useSpinner || process.env.FORCE_COLOR === '1'
  }

  private phaseText(phase: string): string {
    switch (phase) {
      case 'scanning':
        return 'scanning project'
      case 'indexing':
        return 'indexing'
      case 'planning':
        return 'planning'
      case 'validating':
        return 'validating'
      case 'executing':
        return 'executing'
      default:
        return phase
    }
  }

  agentEvent(event: AgentEvent): void {
    if (this.quiet) return
    const key = this.key(event.agent)
    const label = this.label(event.agent)

    switch (event.type) {
      case 'phase': {
        const text = this.phaseText(event.phase)
        this.active.set(key, { label, since: Date.now(), note: text })
        this.drawStatus()
        if (!this.useSpinner) this.writeLine(`\x1b[90m◇ ${label} · ${text}\x1b[0m`)
        return
      }
      case 'llm-start': {
        this.active.set(key, { label, since: Date.now(), note: 'thinking…' })
        this.drawStatus()
        return
      }
      case 'heartbeat': {
        const entry = this.active.get(key)
        if (entry) {
          entry.since = Date.now() - event.elapsedMs
          this.drawStatus()
        }
        return
      }
      case 'llm-end': {
        const budget = event.budget ? ` · round ${event.round}/${event.budget}` : ''
        this.active.delete(key)
        this.clearStatus()
        if (!this.useSpinner) this.writeLine(`\x1b[90m◇ ${label} · ${(event.ms / 1000).toFixed(1)}s${budget}\x1b[0m`)
        else this.drawStatus()
        return
      }
      case 'tool-start': {
        this.active.set(key, {
          label,
          since: Date.now(),
          note: `${event.tool}${event.summary ? ` ${event.summary}` : ''}`,
        })
        this.drawStatus()
        this.writeLine(
          `\x1b[90m${this.toolPrefix(event.agent)}→ ${event.tool}${event.summary ? `  ${event.summary}` : ''}\x1b[0m`,
        )
        return
      }
      case 'tool-end': {
        const detail = event.detail ?? (event.ok ? 'ok' : 'failed')
        // A detail that already carries elapsed (run_command's "exit 0 · 1.4s")
        // must not have the same measurement appended a second time.
        const outcome = /\d+(?:\.\d+)?s\b/.test(detail) ? detail : `${detail} · ${event.ms}ms`
        if (event.ok) this.active.delete(key)
        else this.active.set(key, { label, since: Date.now(), note: `${event.tool} failed` })
        this.drawStatus()
        const color = event.ok ? '32' : '31'
        this.writeLine(
          `\x1b[${color}m${this.toolPrefix(event.agent)}← ${outcome}\x1b[0m`,
        )
        return
      }
    }
  }

  private startSpinner(): void {
    this.drawStatus()
  }

  private stopSpinner(): void {
    this.clearStatus()
  }

  info(message: string): void {
    this.stopSpinner()
    console.log(`\x1b[36m${message}\x1b[0m`)
  }

  success(message: string): void {
    this.stopSpinner()
    console.log(`\x1b[32m✓ ${message}\x1b[0m`)
  }

  error(message: string): void {
    this.stopSpinner()
    process.stderr.write(`\x1b[31m✗ ${message}\x1b[0m\n`)
  }

  warning(message: string): void {
    this.stopSpinner()
    process.stderr.write(`\x1b[33m⚠ ${message}\x1b[0m\n`)
  }

  newline(): void {
    this.stopSpinner()
    console.log('')
  }

  progress(current: number, total: number, message: string): void {
    if (total <= 0) return
    this.stopSpinner()
    const bar = `[${'█'.repeat(Math.floor((current / total) * 20))}${'░'.repeat(20 - Math.floor((current / total) * 20))}]`
    process.stdout.write(`\r\x1b[36m${bar} ${current}/${total}\x1b[0m ${message}`)
    if (current === total) process.stdout.write('\n')
  }

  banner(): void {
    const title = `Vajra v${this.version}`
    const innerWidth = title.length + 2
    const border = '═'.repeat(innerWidth)
    console.log('')
    console.log(`\x1b[1m\x1b[35m╔${border}╗\x1b[0m`)
    console.log(`\x1b[1m\x1b[35m║ ${title} ║\x1b[0m`)
    console.log(`\x1b[1m\x1b[35m╚${border}╝\x1b[0m`)
    console.log('')
  }

  planSummary(plan: { tasks: PlanTaskView[] }): void {
    // Same layout as planSummaryLines, with ANSI colors for the terminal.
    console.log('')
    console.log('\x1b[1m📋 Plan:\x1b[0m')
    console.log('')
    plan.tasks.forEach((task, i) => {
      const timeout = task.timeoutSeconds ? ` (${task.timeoutSeconds}s)` : ''
      console.log(`  \x1b[36m${i + 1}.\x1b[0m ${task.title} \x1b[90m[${task.type}]${timeout}\x1b[0m`)
      if (task.writeFile && task.writeFile.length > 0) {
        console.log(`      \x1b[90mwrites: ${task.writeFile.join(', ')}\x1b[0m`)
      }
      if (task.validation && task.validation.length > 0) {
        console.log(`      \x1b[90mvalidation: ${task.validation.join(' && ')}\x1b[0m`)
      }
      if (task.dependsOn && task.dependsOn.length > 0) {
        console.log(`      \x1b[90mdepends on: ${task.dependsOn.join(', ')}\x1b[0m`)
      }
    })
    console.log('')
  }
}
