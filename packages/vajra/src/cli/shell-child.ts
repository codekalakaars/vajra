#!/usr/bin/env node
import '@codekalakaars/vajra-sandbox/platform-guard'
import { spawn } from 'node:child_process'
import { applySandbox, prepareProtectedShell } from '@codekalakaars/vajra-sandbox'

const insideNamespace = process.argv[2] === '--inside'

if (!insideNamespace) {
  const mountpoint = process.argv[2]
  const rootDir = process.argv[3]
  const runtimeBinary = process.argv[4]
  if (!mountpoint || !rootDir || !runtimeBinary) {
    process.stderr.write('Vajra shell child requires a mountpoint, isolated root, and runtime binary\n')
    process.exit(2)
  }
  try {
    prepareProtectedShell(rootDir, mountpoint, runtimeBinary)
  } catch (error) {
    process.stderr.write(`Vajra refused to start an unconfined shell: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }

  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TERM: process.env.TERM,
    LANG: process.env.LANG,
  }
  const inside = spawn('/runtime/node', ['/runtime/app/cli/shell-child.js', '--inside'], {
    cwd: '/project',
    env,
    stdio: 'inherit',
  })
  const stopInside = () => inside.kill('SIGTERM')
  const ignoreInterrupt = () => {}
  process.on('SIGINT', ignoreInterrupt)
  process.on('SIGTERM', stopInside)
  inside.once('error', (error) => {
    process.stderr.write(`Could not enter the private shell process namespace: ${error.message}\n`)
    process.exitCode = 1
  })
  inside.once('exit', (code, signal) => {
    process.removeListener('SIGTERM', stopInside)
    process.removeListener('SIGINT', ignoreInterrupt)
    process.exitCode = code ?? (signal ? 128 : 1)
  })
} else {
  try {
    // The mounted project is the only project path granted to the shell.
    // FUSE checks its live policy, and Landlock blocks the backing tree.
    applySandbox({ projectDir: '/project', readExecutePaths: ['/runtime'], readWritePaths: ['/tmp'] })
  } catch (error) {
    process.stderr.write(`Vajra refused to start an unconfined shell: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }

  const env: NodeJS.ProcessEnv = {
    HOME: '/tmp',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TERM: process.env.TERM,
    LANG: process.env.LANG,
    PS1: 'vajra:\\w$ ',
  }
  const shell = spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
    cwd: '/project',
    env,
    stdio: 'inherit',
  })
  const stopShell = () => shell.kill('SIGTERM')
  process.on('SIGINT', () => {})
  process.on('SIGTERM', stopShell)
  shell.once('error', (error) => {
    process.stderr.write(`Could not start the protected shell: ${error.message}\n`)
    process.exitCode = 1
  })
  shell.once('exit', (code, signal) => {
    process.removeListener('SIGTERM', stopShell)
    process.exitCode = code ?? (signal ? 128 : 1)
  })
}
