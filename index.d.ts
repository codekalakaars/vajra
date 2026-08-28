export function version(): string

// File operations
export function readFile(path: string): string
export function writeFile(path: string, content: string): void
export function editFile(path: string, oldString: string, newString: string): boolean
export function deleteFile(path: string): void
export function createDir(path: string): void
export function listFiles(path: string, recursive?: boolean): FileEntry[]
export function fileExists(path: string): boolean
export function isFile(path: string): boolean
export function isDir(path: string): boolean
export function copyFile(source: string, destination: string): void
export function renameFile(source: string, destination: string): void
export function fileSize(path: string): number

export interface FileEntry {
  name: string
  path: string
  isFile: boolean
  isDir: boolean
  size: number
}

// Process operations
export function runCommand(command: string, args?: string[], cwd?: string): CommandResult
export function runShell(command: string, cwd?: string): CommandResult
export function which(command: string): string | null

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

// Environment operations
export function getEnv(key: string): string | undefined
export function setEnv(key: string, value: string): void
export function removeEnv(key: string): void
export function envExists(key: string): boolean
export function getAllEnv(): EnvVar[]
export function getEnvFiltered(prefix: string): EnvVar[]
export function currentDir(): string
export function setCurrentDir(path: string): void
export function homeDir(): string | undefined
export function tempDir(): string

export interface EnvVar {
  key: string
  value: string
}

// Path operations
export function resolvePath(path: string): string
export function normalizePath(path: string): string
export function joinPaths(base: string, relative: string): string
export function dirname(path: string): string | undefined
export function basename(path: string, ext?: string): string | undefined
export function extension(path: string): string | undefined
export function isAbsolute(path: string): boolean
export function pathExists(path: string): boolean
export function parentPath(path: string): string | undefined
export function ensureExt(path: string, ext: string): string
