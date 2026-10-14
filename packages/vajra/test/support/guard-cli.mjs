#!/usr/bin/env node
// Test-only entry point for the guard. The public `vajra` command starts the shell and
// has no `guard` subcommand; the kernel tests still need to run a confined command, so
// they go through this helper with the same arguments the guard used to take.
import { Command } from 'commander'
import { guardCommand } from '../../dist/guard/command.js'

const program = new Command().name('vajra').enablePositionalOptions()
program.addCommand(guardCommand())
program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`vajra: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
