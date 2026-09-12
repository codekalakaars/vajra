import * as readline from 'node:readline'

export class TerminalStreamer {
  private currentLine = ''
  private isThinking = false

  constructor(private verbose = false) {}

  onTextDelta(text: string): void {
    this.currentLine += text
    process.stdout.write(text)
  }

  onThinkingDelta(text: string): void {
    if (this.verbose) {
      if (!this.isThinking) {
        process.stderr.write('\x1b[90m[thinking] ')
        this.isThinking = true
      }
      process.stderr.write(text)
    }
  }

  finishLine(): void {
    if (this.isThinking) {
      process.stderr.write('\x1b[0m\n')
      this.isThinking = false
    }
    if (this.currentLine.length > 0) {
      process.stdout.write('\n')
      this.currentLine = ''
    }
  }

  info(message: string): void {
    console.log(`\x1b[36m${message}\x1b[0m`)
  }

  success(message: string): void {
    console.log(`\x1b[32m✓ ${message}\x1b[0m`)
  }

  error(message: string): void {
    console.log(`\x1b[31m✗ ${message}\x1b[0m`)
  }

  warning(message: string): void {
    console.log(`\x1b[33m⚠ ${message}\x1b[0m`)
  }

  progress(current: number, total: number, message: string): void {
    const bar = `[${'█'.repeat(Math.floor((current / total) * 20))}${'░'.repeat(20 - Math.floor((current / total) * 20))}]`
    process.stdout.write(`\r\x1b[36m${bar} ${current}/${total}\x1b[0m ${message}`)
    if (current === total) process.stdout.write('\n')
  }

  banner(): void {
    console.log('')
    console.log('\x1b[1m\x1b[35m╔══════════════════════════════════════╗\x1b[0m')
    console.log('\x1b[1m\x1b[35m║         🚀 Vajra CLI v0.1.0         ║\x1b[0m')
    console.log('\x1b[1m\x1b[35m╚══════════════════════════════════════╝\x1b[0m')
    console.log('')
  }

  planSummary(plan: { tasks: Array<{ title: string; type: string; timeout?: number }> }): void {
    console.log('')
    console.log('\x1b[1m📋 Plan:\x1b[0m')
    console.log('')
    plan.tasks.forEach((task, i) => {
      const timeout = task.timeout ? ` (${task.timeout}s)` : ''
      console.log(`  \x1b[36m${i + 1}.\x1b[0m ${task.title} \x1b[90m[${task.type}]${timeout}\x1b[0m`)
    })
    console.log('')
  }
}
