export class TerminalStreamer {
  private currentLine = ''
  private isThinking = false

  constructor(private verbose = false, private version = '0.0.1') {}

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
    process.stderr.write(`\x1b[31m✗ ${message}\x1b[0m\n`)
  }

  warning(message: string): void {
    process.stderr.write(`\x1b[33m⚠ ${message}\x1b[0m\n`)
  }

  progress(current: number, total: number, message: string): void {
    if (total <= 0) return
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

  planSummary(plan: {
    tasks: Array<{
      title: string
      type: string
      timeoutSeconds?: number
      writeFile?: string[]
      validation?: string[]
      dependsOn?: string[]
    }>
  }): void {
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
