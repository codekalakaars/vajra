#!/usr/bin/env node

// Must stay the first import: it runs before the native addon is loaded, so an
// unsupported platform gets the real reason rather than a loader error.
import '@codekalakaars/vajra-sandbox/platform-guard'
import { Command } from 'commander'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { doctorCommand } from './doctor.js'
import { runProtectedShell } from './shell.js'

function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const program = new Command()

program
  .name('vajra')
  .description('Confine a shell so an AI coding agent running inside it cannot go haywire')
  .version(readPackageVersion())
  .option('--no-browser', 'Do not open the control page in a browser; its address is printed instead')

program.addCommand(doctorCommand())

program.action(async (options: { browser: boolean }) => {
  await runProtectedShell({ browser: options.browser })
})

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`vajra: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
