import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface TaskFilePermissions {
  read: boolean
  write: boolean
  edit: boolean
  delete: boolean
}

/** Normalise a path to a project-relative posix path for permission lookup. */
export function normalizeProjectPath(projectDir: string, filePath: string): string {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(projectDir, filePath)
  const rel = relative(projectDir, abs)
  if (rel.startsWith('..') || (isAbsolute(rel) && rel !== projectDir)) {
    // Outside the project — keep a stable key rather than throwing here;
    // callers decide whether outside paths are allowed.
    return abs.split(sep).join('/')
  }
  return rel.split(sep).join('/')
}

export function computeTaskPermissions(
  task: { readFile: string[]; writeFile: string[]; deleteFile: string[]; createDir?: string[] },
  projectDir?: string,
): Record<string, TaskFilePermissions> {
  const norm = (p: string) => (projectDir ? normalizeProjectPath(projectDir, p) : p.split(sep).join('/'))
  const files: Record<string, TaskFilePermissions> = {}

  for (const file of task.readFile) {
    files[norm(file)] = { read: true, write: false, edit: false, delete: false }
  }
  for (const file of task.writeFile) {
    files[norm(file)] = { read: true, write: true, edit: true, delete: false }
  }
  for (const file of task.deleteFile) {
    files[norm(file)] = { read: true, write: false, edit: false, delete: true }
  }
  for (const dir of task.createDir ?? []) {
    files[norm(dir)] = { read: true, write: true, edit: true, delete: false }
  }

  const allFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile, ...(task.createDir ?? [])]
  const dirs = new Set(allFiles.map(f => {
    const parts = norm(f).split('/')
    parts.pop()
    return parts.join('/')
  }).filter(Boolean))

  for (const dir of dirs) {
    if (!files[dir]) {
      // Grant write on parent dirs of writeFile entries so workers can create
      // new files in those directories.
      const isWriteParent = [...task.writeFile, ...(task.createDir ?? [])].some(f => {
        const parent = norm(f).split('/').slice(0, -1).join('/')
        return parent === dir || dir.startsWith(parent + '/')
      }) || (task.createDir ?? []).some(d => norm(d) === dir || dir.startsWith(norm(d) + '/'))
      const isDeleteParent = task.deleteFile.some(f => {
        const parent = norm(f).split('/').slice(0, -1).join('/')
        return parent === dir || dir.startsWith(parent + '/')
      })
      files[dir] = {
        read: true,
        write: isWriteParent,
        edit: isWriteParent,
        delete: isDeleteParent,
      }
    }
  }

  return files
}
