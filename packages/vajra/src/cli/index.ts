#!/usr/bin/env node

// Must stay the first import: it runs before the native addon is loaded, so an
// unsupported platform gets the real reason rather than a loader error.
import '@codekalakaars/vajra-sandbox/platform-guard'

import { Command } from 'commander'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readAuth, writeAuth, clearAuth } from '../model/auth.js'
import { authPath } from '../model/home.js'
import { benchCommand } from '../bench/run.js'

function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function maskKey(value: string): string {
  if (value.length <= 12) return '***'
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

const program = new Command()

program
  .name('vajra')
  .description('Vajra: a Manager runs a plan of tasks on parallel, sandboxed Workers')
  .version(readPackageVersion())

program
  .command('auth')
  .description('Manage API credentials (~/.vajra/auth.json, mode 0600)')
  .argument('[subcommand]', 'login <key> | status | logout', 'status')
  .argument('[key]', 'API key for login')
  .action((subcommand, key) => {
    const action = String(subcommand ?? 'status')

    if (action === 'login') {
      const apiKey = typeof key === 'string' && key.trim() ? key.trim() : ''
      if (!apiKey) {
        console.error('Usage: vajra auth login <key>')
        process.exit(1)
      }
      const path = writeAuth({ OPENCODE_API_KEY: apiKey })
      console.log(`Stored OPENCODE_API_KEY (${maskKey(apiKey)})`)
      console.log(`  → ${path} (mode 0600)`)
      return
    }

    if (action === 'logout') {
      if (clearAuth()) {
        console.log(`Removed credentials from ${authPath()}`)
        if (process.env.OPENCODE_API_KEY?.trim()) {
          console.log('\x1b[33mNote: OPENCODE_API_KEY is still exported in this shell; unset it there too.\x1b[0m')
        }
      } else {
        console.log('No stored credentials to remove')
      }
      return
    }

    if (action === 'status') {
      const fromEnv = process.env.OPENCODE_API_KEY?.trim()
      const stored = readAuth().OPENCODE_API_KEY
      const source = fromEnv ? 'env' : stored ? 'auth.json' : null
      if (!source) {
        console.log('Not logged in')
        console.log('  Set one with: vajra auth login <key>')
        process.exit(1)
      }
      console.log(`OPENCODE_API_KEY ${maskKey(fromEnv ?? stored ?? '')} (from ${source})`)
      console.log(`  auth file: ${authPath()}`)
      return
    }

    console.error(`Unknown subcommand '${action}'. Usage: vajra auth [login <key>|status|logout]`)
    process.exit(1)
  })

// `vajra bench <suite>`: the arrangement in bench/config.json, run against a
// predefined plan with no Developer and no input.
program.addCommand(benchCommand())

program.parse()
