import { resolveDefaultDir, resolveDefaultModel } from '../config.js'
import { startSession } from './session/index.js'
import { startOpenTuiSession } from './opentui/host.js'

export interface TuiOptions {
  version: string
  /** Initial task from `vajra run "…"` — the session starts running it. */
  task?: string
  /** Resume this persisted session instead of starting a new one. */
  resumeFrom?: string
  /** Skip the staleness gate — only ever set from an explicit user choice. */
  force?: boolean
  model?: string
  projectDir?: string
  /** Raw `--api-key`; otherwise resolved from env/auth (and re-resolved on /model). */
  apiKey?: string
  autoConfirm?: boolean
  timeout?: number
  allowUnenforced?: boolean
  concurrency?: number
}

/**
 * Launch the full-screen TUI. There is no menu screen: the session is the
 * app, and its options are slash commands at the prompt. Settings seed from
 * the CLI flags, falling back to the saved defaults
 * (~/.vajra/config.json), then stay session-scoped until saved again with
 * /defaults.
 */
export async function startTUI(options: TuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Vajra CLI - Run with --help for usage')
    return 0
  }
  // OpenTUI is the front-end; the Ink session is kept as a fallback because it
  // needs nothing but node. VAJRA_TUI=ink is the escape hatch.
  const driver = process.env.VAJRA_TUI === 'ink' ? startSession : startOpenTuiSession
  return driver({
    version: options.version,
    model: options.model ?? resolveDefaultModel(),
    projectDir: options.projectDir ?? resolveDefaultDir(),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.task !== undefined ? { initialTask: options.task } : {}),
    ...(options.resumeFrom !== undefined ? { resumeFrom: options.resumeFrom } : {}),
    ...(options.force ? { force: true } : {}),
    ...(options.autoConfirm ? { autoConfirm: true } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.allowUnenforced ? { allowUnenforced: true } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
  })
}
