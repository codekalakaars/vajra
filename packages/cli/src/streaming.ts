import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'
import { markedTerminal } from 'marked-terminal'

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

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

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

export class TerminalStreamer {
  private buffer = ''
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private spinnerFrame = 0
  private isThinking = false
  private readonly useSpinner: boolean

  constructor(private verbose = false, private version = readPackageVersion()) {
    this.useSpinner = Boolean(process.stdout.isTTY)
  }

  onTextDelta(text: string): void {
    this.buffer += text
    this.startSpinner()
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
    this.stopSpinner()
    if (this.isThinking) {
      process.stderr.write('\x1b[0m\n')
      this.isThinking = false
    }
    if (this.buffer.length > 0) {
      const rendered = renderMarkdown(this.buffer)
      process.stdout.write(rendered)
      this.buffer = ''
    }
  }

  /** Drop any unflushed buffer without printing (error paths). */
  discardBuffer(): void {
    this.stopSpinner()
    this.buffer = ''
    if (this.isThinking) {
      process.stderr.write('\x1b[0m\n')
      this.isThinking = false
    }
  }

  private startSpinner(): void {
    if (!this.useSpinner || this.spinnerTimer) return
    this.spinnerFrame = 0
    const tick = () => {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]
      this.spinnerFrame++
      process.stderr.write(`\r\x1b[90m${frame}\x1b[0m`)
    }
    tick()
    this.spinnerTimer = setInterval(tick, 80)
    this.spinnerTimer.unref?.()
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return
    clearInterval(this.spinnerTimer)
    this.spinnerTimer = null
    process.stderr.write('\r\x1b[2K')
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
