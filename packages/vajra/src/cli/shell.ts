import { spawn, spawnSync } from 'node:child_process'
import { cpSync, copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, lstatSync, statfsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Command } from 'commander'
import { createSandboxConfig, loadSandboxConfig, saveSandboxConfig, type FilePermissions } from '@codekalakaars/vajra-sandbox'
import { startConfigServer } from './config-server.js'
import { fileURLToPath } from 'node:url'

const VFS_SUPER_MAGIC = 0x65735546
const DENY: FilePermissions = { read: false, write: false, edit: false, delete: false }

function ensureConfigFile(projectRoot: string, environment: string) {
  const path = join(projectRoot, '.vajra-sandbox.json')
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Refusing to start: .vajra-sandbox.json must be a regular file, not a symlink')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (environment === 'default') {
      saveSandboxConfig(projectRoot, createSandboxConfig({ projectDir: projectRoot, defaultPermissions: DENY }))
    }
  }
  if (environment !== 'default' && !loadSandboxConfig(projectRoot, environment)) {
    throw new Error(`Sandbox environment '${environment}' is not configured in .vajra-sandbox.json`)
  }
}

function mountReady(path: string): boolean {
  try { return Number(statfsSync(path).type) === VFS_SUPER_MAGIC }
  catch { return false }
}

function stageShellRuntime(rootDir: string, cliDir: string) {
  const vajraPackage = resolve(cliDir, '..', '..')
  const sandboxPackage = resolve(dirname(fileURLToPath(import.meta.resolve('@codekalakaars/vajra-sandbox'))), '..')
  const nativePackage = dirname(fileURLToPath(import.meta.resolve('@codekalakaars/vajra-native')))
  const appDir = join(rootDir, 'runtime', 'app')
  const appCliDir = join(appDir, 'cli')
  const scopedModules = join(appDir, 'node_modules', '@codekalakaars')
  const sandboxTarget = join(scopedModules, 'vajra-sandbox')
  const nativeTarget = join(scopedModules, 'vajra-native')
  mkdirSync(appCliDir, { recursive: true })
  mkdirSync(sandboxTarget, { recursive: true })
  mkdirSync(nativeTarget, { recursive: true })
  copyFileSync(join(vajraPackage, 'dist', 'cli', 'shell-child.js'), join(appCliDir, 'shell-child.js'))
  cpSync(join(sandboxPackage, 'dist'), join(sandboxTarget, 'dist'), { recursive: true })
  cpSync(join(sandboxPackage, 'package.json'), join(sandboxTarget, 'package.json'))
  cpSync(join(nativePackage, 'index.js'), join(nativeTarget, 'index.js'))
  cpSync(join(nativePackage, 'index.d.ts'), join(nativeTarget, 'index.d.ts'))
  cpSync(join(nativePackage, 'package.json'), join(nativeTarget, 'package.json'))
  for (const name of readdirSync(nativePackage).filter((file) => file.endsWith('.node'))) {
    cpSync(join(nativePackage, name), join(nativeTarget, name))
  }
  writeFileSync(join(rootDir, 'runtime', 'node'), '', { mode: 0o755 })
}

async function waitForMount(server: ReturnType<typeof spawn>, mountpoint: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (server.pid === undefined || server.exitCode !== null) throw new Error(`VFS server exited before mounting (status ${server.exitCode ?? 'spawn failed'})`)
    if (mountReady(mountpoint)) return
    await delay(50)
  }
  throw new Error('Timed out waiting for the protected project mount')
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
}

async function openConfigPage(url: string): Promise<boolean> {
  for (const [command, args] of [['xdg-open', [url]], ['gio', ['open', url]]] as const) {
    const opened = await new Promise<boolean>((resolveOpen) => {
      let settled = false
      let timeout: NodeJS.Timeout
      const finish = (result: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolveOpen(result)
      }
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      timeout = setTimeout(() => {
        child.unref()
        finish(true)
      }, 2_000)
      child.once('error', () => finish(false))
      child.once('spawn', () => child.unref())
      child.once('close', (code) => finish(code === 0))
    })
    if (opened) return true
  }
  return false
}

async function runProtectedShell(environment: string) {
  const projectRoot = resolve(process.cwd())
  ensureConfigFile(projectRoot, environment)

  const configServer = await startConfigServer(projectRoot, environment)
  const browserOpened = await openConfigPage(configServer.browserUrl)
  process.stdout.write(`Vajra settings page: ${configServer.url}\n`)
  if (!browserOpened) process.stdout.write('Could not open a host browser automatically; open the settings URL above.\n')
  let sessionRoot: string | undefined
  let mountpoint: string | undefined
  let vfsServer: ReturnType<typeof spawn> | undefined
  let shell: ReturnType<typeof spawn> | undefined
  let primaryError: unknown
  const ignoreInterrupt = () => {}
  const stopShell = () => shell?.kill('SIGTERM')
  process.on('SIGINT', ignoreInterrupt)
  process.on('SIGTERM', stopShell)
  try {
    sessionRoot = mkdtempSync(join(tmpdir(), 'vajra-session-'))
    mountpoint = join(sessionRoot, 'project')
    const rootDir = join(sessionRoot, 'root')
    const cliDir = dirname(fileURLToPath(import.meta.url))
    mkdirSync(mountpoint)
    for (const path of ['usr', 'bin', 'sbin', 'lib', 'lib64', 'etc', 'dev', 'proc', 'tmp', 'project', '.old_root']) {
      mkdirSync(join(rootDir, path), { recursive: true })
    }
    for (const path of ['null', 'urandom', 'random']) {
      writeFileSync(join(rootDir, 'dev', path), '', { mode: 0o600 })
    }
    stageShellRuntime(rootDir, cliDir)
    vfsServer = spawn(process.execPath, [join(cliDir, 'vfs-server.js'), projectRoot, mountpoint, join(projectRoot, '.vajra-sandbox.json'), environment], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    await waitForMount(vfsServer, mountpoint)
    process.stdout.write(`Vajra mounted ${projectRoot} with live file rules.\n`)
    process.stdout.write('Network access is available. Type exit to leave.\n')
    shell = spawn('unshare', [
      '--user', '--map-root-user', '--mount', '--pid', '--fork', '--',
      process.execPath, join(cliDir, 'shell-child.js'), mountpoint, rootDir, process.execPath,
    ], {
      stdio: 'inherit',
    })
    shell.once('error', (error) => { primaryError = error })
    await waitForExit(shell)
    if (primaryError) throw primaryError
    if (shell.signalCode) throw new Error(`Protected shell exited after signal ${shell.signalCode}`)
    if (shell.exitCode !== 0) throw new Error(`Protected shell exited with status ${shell.exitCode ?? 'unknown'}`)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    process.removeListener('SIGINT', ignoreInterrupt)
    process.removeListener('SIGTERM', stopShell)
    if (shell && shell.exitCode === null && shell.signalCode === null) {
      shell.kill('SIGTERM')
      await waitForExit(shell)
    }
    if (mountpoint) spawnSync('fusermount3', ['-u', mountpoint], { stdio: 'ignore' })
    if (vfsServer && vfsServer.exitCode === null && vfsServer.signalCode === null) {
      vfsServer.kill('SIGTERM')
      await waitForExit(vfsServer)
    }
    await configServer.close()
    try { if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true }) }
    catch (cleanupError) {
      if (!primaryError) throw new Error(`Could not clean up the Vajra mount: ${String(cleanupError)}`)
    }
  }
}

export function shellCommand(): Command {
  return new Command('shell')
    .description('Start a protected shell in a live, policy-filtered project mount')
    .option('-e, --environment <name>', 'Sandbox environment from .vajra-sandbox.json', 'default')
    .action(async (options: { environment: string }) => {
      await runProtectedShell(options.environment)
    })
}

export { runProtectedShell }

