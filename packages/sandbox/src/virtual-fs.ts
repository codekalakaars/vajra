import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createSandboxConfig, type FileRule, type SandboxConfig } from './config.js'
import { CompiledRules } from './file-rules.js'
import { DEFAULT_CONFIG_FILE, loadSandboxConfig } from './file-config.js'
import { isMaskedName, loadEnvFile, redact, scanProject } from './native.js'
import type { FilePermissions, ProjectFileEntry } from './types.js'

const DENY_ALL: FilePermissions = { read: false, write: false, edit: false, delete: false }
const MASKED_CONTENT = '[REDACTED: masked file — contents withheld]'
const CONTROL_FILES = new Set([DEFAULT_CONFIG_FILE, '.vajra-perms.json'])

export interface VirtualFileSystemChange {
  revision: number
}

export type VirtualFileSystemListener = (change: VirtualFileSystemChange) => void

export interface VirtualFileSystemView {
  list(path?: string): ProjectFileEntry[]
  readFile(path: string): string
  writeFile(path: string, content: string): void
  editFile(path: string, oldText: string, newText: string): void
  deleteFile(path: string): void
  createDirectory(path: string): void
}

/**
 * A live, policy-checked view of one project directory.
 *
 * Give an agent this object instead of the host filesystem APIs. Its listing
 * methods hide unreadable paths, and every operation checks the current policy.
 * This is a mediation layer, not a mounted filesystem or an OS sandbox.
 */
export class VirtualFileSystem {
  #rules: CompiledRules
  #revisionValue = 0
  #listeners = new Set<VirtualFileSystemListener>()
  #projectRoot: string

  /** Give this restricted object to an agent; keep the controller parent-side. */
  readonly view: VirtualFileSystemView

  constructor(config: SandboxConfig) {
    this.#projectRoot = resolve(config.projectDir)
    const rootInfo = lstatSync(this.#projectRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('The virtual filesystem root must be a real directory')
    }
    this.#rules = this.compile(this.forProject(config))
    this.view = Object.freeze({
      list: (path?: string) => this.list(path),
      readFile: (path: string) => this.readFile(path),
      writeFile: (path: string, content: string) => this.writeFile(path, content),
      editFile: (path: string, oldText: string, newText: string) => this.editFile(path, oldText, newText),
      deleteFile: (path: string) => this.deleteFile(path),
      createDirectory: (path: string) => this.createDirectory(path),
    })
  }

  get revision(): number {
    return this.#revisionValue
  }

  /**
   * Replace the policy atomically. New operations use it immediately; an
   * operation already in progress finishes with the policy it started with.
   */
  updateConfig(config: SandboxConfig): number {
    const nextConfig = this.forProject(config)
    const nextRules = this.compile(nextConfig)
    this.#rules = nextRules
    this.#revisionValue++

    const change = { revision: this.#revisionValue }
    for (const listener of this.#listeners) {
      try {
        listener(change)
      } catch {
        // A subscriber must not leave the filesystem in a half-updated state.
      }
    }
    return this.#revisionValue
  }

  /** Replace the visible read allowlist and revoke every other permission. */
  setVisiblePaths(patterns: readonly string[]): number {
    const fileRules = allowRules(patterns)
    return this.updateConfig(createSandboxConfig({
      projectDir: this.#projectRoot,
      defaultPermissions: DENY_ALL,
      fileRules,
    }))
  }

  /** Watch `.vajra-sandbox.json`; invalid or missing policy changes deny all. */
  watchConfig(environment?: string, debounceMs = 50): () => void {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const denyAll = () => createSandboxConfig({
      projectDir: this.#projectRoot,
      defaultPermissions: DENY_ALL,
    })
    const reload = () => {
      if (closed) return
      try {
        const configPath = resolve(this.#projectRoot, DEFAULT_CONFIG_FILE)
        if (existsSync(configPath)) this.assertNoSymlinkComponents(configPath, false)
        this.updateConfig(loadSandboxConfig(this.#projectRoot, environment) ?? denyAll())
      } catch {
        this.updateConfig(denyAll())
      }
    }

    let watcher
    try {
      watcher = watch(this.#projectRoot, { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== DEFAULT_CONFIG_FILE) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(reload, debounceMs)
      })
      watcher.on('error', () => this.updateConfig(denyAll()))
    } catch (error) {
      this.updateConfig(denyAll())
      throw error
    }

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      watcher.close()
    }
  }

  onPolicyChange(listener: VirtualFileSystemListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** List only readable files and directories that contain readable files. */
  list(path = ''): ProjectFileEntry[] {
    const { absolute, relativePath: directory } = this.normalize(path, true)
    const snapshot = this.#rules
    const entries = scanProject(this.#projectRoot)
    const visibleFiles = new Set(
      entries
        .filter((entry) => !entry.isDir && snapshot.resolve(entry.path).read)
        .map((entry) => entry.path),
    )
    const visibleDirectories = new Set<string>()
    for (const file of visibleFiles) {
      let parent = dirname(file).split(sep).join('/')
      while (parent && parent !== '.') {
        visibleDirectories.add(parent)
        parent = dirname(parent).split(sep).join('/')
      }
    }

    if (directory && !visibleDirectories.has(directory)) return []
    this.assertNoSymlinkComponents(absolute, false)

    return entries.filter((entry) => {
      const parent = dirname(entry.path).split(sep).join('/')
      if ((parent === '.' ? '' : parent) !== directory) return false
      if (entry.isDir) return visibleDirectories.has(entry.path)
      return visibleFiles.has(entry.path)
    })
  }

  /** Read a visible file. Masked environment files never expose their contents. */
  readFile(path: string): string {
    const { absolute, relativePath } = this.normalize(path)
    this.assertNotControlFile(relativePath)
    const permissions = this.#rules.resolve(relativePath)
    if (!permissions.read) throw new Error(`Read access denied: ${relativePath}`)
    this.assertRegularFile(absolute, relativePath)

    if (isMaskedName(relativePath.split('/').at(-1) ?? '')) return MASKED_CONTENT

    const content = readFileSync(absolute, 'utf-8')
    const envPath = resolve(this.#projectRoot, '.env')
    if (existsSync(envPath)) this.assertNoSymlinkComponents(envPath, false)
    const secrets = existsSync(envPath) ? loadEnvFile(envPath) : []
    return redact(content, secrets)
  }

  writeFile(path: string, content: string): void {
    const { absolute, relativePath } = this.normalize(path)
    this.assertNotControlFile(relativePath)
    if (isMaskedName(relativePath.split('/').at(-1) ?? '')) {
      throw new Error(`Masked files cannot be changed through the virtual filesystem: ${relativePath}`)
    }
    if (!this.#rules.resolve(relativePath).write) {
      throw new Error(`Write access denied: ${relativePath}`)
    }
    this.assertNoSymlinkComponents(absolute, true)
    writeFileSync(absolute, content, 'utf-8')
  }

  editFile(path: string, oldText: string, newText: string): void {
    const { absolute, relativePath } = this.normalize(path)
    this.assertNotControlFile(relativePath)
    if (isMaskedName(relativePath.split('/').at(-1) ?? '')) {
      throw new Error(`Masked files cannot be changed through the virtual filesystem: ${relativePath}`)
    }
    const permissions = this.#rules.resolve(relativePath)
    if (!permissions.read || !permissions.edit) {
      throw new Error(`Edit access denied: ${relativePath}`)
    }
    this.assertRegularFile(absolute, relativePath)
    const content = readFileSync(absolute, 'utf-8')
    const index = content.indexOf(oldText)
    if (index < 0) throw new Error(`Text to replace was not found in ${relativePath}`)
    writeFileSync(absolute, content.slice(0, index) + newText + content.slice(index + oldText.length), 'utf-8')
  }

  deleteFile(path: string): void {
    const { absolute, relativePath } = this.normalize(path)
    this.assertNotControlFile(relativePath)
    if (isMaskedName(relativePath.split('/').at(-1) ?? '')) {
      throw new Error(`Masked files cannot be changed through the virtual filesystem: ${relativePath}`)
    }
    if (!this.#rules.resolve(relativePath).delete) {
      throw new Error(`Delete access denied: ${relativePath}`)
    }
    this.assertRegularFile(absolute, relativePath)
    rmSync(absolute)
  }

  createDirectory(path: string): void {
    const { absolute, relativePath } = this.normalize(path)
    if (!this.#rules.resolve(relativePath).write) {
      throw new Error(`Directory write access denied: ${relativePath}`)
    }
    this.assertNoSymlinkComponents(absolute, true)
    mkdirSync(absolute)
  }

  private forProject(config: SandboxConfig): SandboxConfig {
    if (resolve(config.projectDir) !== this.#projectRoot) {
      throw new Error('A virtual filesystem cannot change its project directory')
    }
    return createSandboxConfig({
      projectDir: this.#projectRoot,
      defaultPermissions: Object.freeze({ ...config.defaultPermissions }),
      fileRules: config.fileRules.map((rule) => Object.freeze({ ...rule })),
      allowUnenforced: config.allowUnenforced,
      readExecutePaths: [...config.readExecutePaths],
      readWritePaths: [...config.readWritePaths],
    })
  }

  private compile(config: SandboxConfig): CompiledRules {
    return new CompiledRules(config.defaultPermissions, config.fileRules)
  }

  private assertNotControlFile(relativePath: string): void {
    if (CONTROL_FILES.has(relativePath)) {
      throw new Error(`Sandbox control files are not exposed through the virtual filesystem`)
    }
  }

  private normalize(path: string, directory = false): { absolute: string; relativePath: string } {
    if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path)) {
      throw new Error('Virtual filesystem paths must be relative to the project')
    }
    const absolute = resolve(this.#projectRoot, path || '.')
    const relativePath = relative(this.#projectRoot, absolute)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Path escapes the virtual filesystem: ${path}`)
    }
    if (!directory && relativePath === '') {
      throw new Error('The project root is not a file')
    }
    return { absolute, relativePath: relativePath.split(sep).join('/') }
  }

  private assertRegularFile(absolute: string, relativePath: string): void {
    this.assertNoSymlinkComponents(absolute, false)
    const info = lstatSync(absolute)
    if (!info.isFile()) throw new Error(`Not a regular file: ${relativePath}`)
  }

  private assertNoSymlinkComponents(absolute: string, allowMissingLeaf: boolean): void {
    const relativePath = relative(this.#projectRoot, absolute)
    const parts = relativePath ? relativePath.split(sep) : []
    let current = this.#projectRoot
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]!)
      let info
      try {
        info = lstatSync(current)
      } catch (error) {
        if (allowMissingLeaf && index === parts.length - 1) return
        throw error
      }
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not exposed through the virtual filesystem')
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new Error('A parent path is not a directory')
      }
    }
  }
}

/** Create a VFS with deny-by-default visibility. */
export function createVirtualFileSystem(
  projectDir: string,
  visiblePaths: readonly string[] = [],
): VirtualFileSystem {
  const config = createSandboxConfig({
    projectDir,
    defaultPermissions: DENY_ALL,
    fileRules: allowRules(visiblePaths),
  })
  return new VirtualFileSystem(config)
}

function allowRules(patterns: readonly string[]): FileRule[] {
  return patterns.map((pattern) => {
    if (!pattern.trim() || pattern.startsWith('!')) {
      throw new Error('Visible paths must be non-empty allow patterns, without negation')
    }
    return { pattern, read: true }
  })
}
