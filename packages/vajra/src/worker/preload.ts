import type { LaunchHandle } from '@codekalakaars/vajra-sandbox'
import { capToolOutput } from './output-cap.js'

/** One file's preload: its contents, or why it has none. */
interface PreloadedRead {
  path: string
  content?: string
  error?: string
}

/**
 * The task's read files, loaded before the first round and handed over in the
 * first user message.
 *
 * Read through the same handle the Worker's own reads go through, so what the
 * Worker is given is what `read_file` would have answered — the permission gate
 * and the masked-file stub included — and they run together because they are
 * independent. A file that cannot be read is named as unread rather than left
 * out: silence would leave the Worker planning against contents it never saw.
 *
 * These are the arrangement's reads, not the Worker's: they are not tool calls,
 * so they are not announced as ones and they do not spend the call budget.
 */
export async function preloadReadFiles(
  paths: string[],
  handle: LaunchHandle,
  maxChars: number,
  onUnreadable: (path: string, why: string) => void,
): Promise<string | null> {
  if (paths.length === 0) return null
  const settled: PreloadedRead[] = await Promise.all(
    paths.map(async path => {
      try {
        const result = await handle.callTool('read_file', { path })
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
        // Capped like any read the Worker makes itself, so preloading cannot be
        // the thing that fills the window.
        return { path, content: capToolOutput('read_file', text, maxChars) }
      } catch (e) {
        return { path, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
  const blocks: string[] = []
  for (const { path, content, error } of settled) {
    if (error !== undefined) {
      onUnreadable(path, error)
      blocks.push([
        `--- NOT READ: ${path} ---`,
        `It could not be read before you started: ${error}`,
        'Read it yourself with read_file if the task needs it.',
      ].join('\n'))
      continue
    }
    blocks.push([
      `--- BEGIN FILE: ${path} ---`,
      content ?? '',
      `--- END FILE: ${path} ---`,
    ].join('\n'))
  }
  return [
    'These files were read for you. Their contents are as of this message, so do not',
    'call read_file on them again unless you need a window this text does not show.',
    '',
    ...blocks,
  ].join('\n')
}
