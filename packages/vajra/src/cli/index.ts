#!/usr/bin/env node

// Must stay the first import: it runs before the native addon is loaded, so an
// unsupported platform gets the real reason rather than a loader error.
import '@codekalakaars/vajra-sandbox/platform-guard'
import { Command } from 'commander'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { doctorCommand } from './doctor.js'

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

program.addCommand(doctorCommand())

program.parse()
