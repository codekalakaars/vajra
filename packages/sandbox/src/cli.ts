#!/usr/bin/env node
// vajra — main CLI entry point.
// Commands: secure, sandbox, help

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadNative() {
  try {
    const localRequire = createRequire(join(__dirname, '..', 'node_modules', 'placeholder'))
    return localRequire('@codekalakaars/vajra-core')
  } catch {}

  try {
    const pkgRequire = createRequire(join(__dirname, '..', '..', 'node_modules', 'placeholder'))
    return pkgRequire('@codekalakaars/vajra-core')
  } catch {}

  try {
    const globalRequire = createRequire(import.meta.url)
    return globalRequire('@codekalakaars/vajra-core')
  } catch {}

  return null
}

const native = loadNative()

const subcommands: Record<string, () => Promise<void>> = {
  secure: () => import('./secure-cli.js').then((m) => m.run(native)),
  sandbox: () => import('./sandbox-cli.js').then((m) => m.run()),
}

function printHelp() {
  console.log(`
vajra — AI agent sandbox

Usage:
  vajra <command> [options]

Commands:
  secure                      Sandbox the current terminal
  sandbox start               Start the sandbox daemon
  sandbox stop                Stop the sandbox daemon
  sandbox status              Show daemon status
  sandbox locks               List active file locks
  sandbox agents              List connected agents
  help                        Show this help

Run 'vajra <command> --help' for more info on a command.
`)
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  const handler = subcommands[command]
  if (!handler) {
    console.error(`Unknown command: ${command}`)
    console.error(`Run 'vajra help' for available commands.`)
    process.exit(1)
  }

  process.argv = [process.argv[0], process.argv[1], ...args.slice(1)]
  await handler()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
