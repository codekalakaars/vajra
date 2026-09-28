/**
 * The options a front-end is started with.
 *
 * Its own module because it used to live in the Ink session, and the OpenTUI
 * host imported it from there — a type-only import, so nothing reached it at
 * runtime, but `tsc` still had to compile the entire Ink tree to typecheck one
 * interface. That is the coupling that made the fallback expensive to remove:
 * the shared plumbing was filed under the front-end that was optional.
 */
export interface TuiSessionOptions {
  version: string
  model: string
  projectDir: string
  timeout?: number
  autoConfirm?: boolean
  allowUnenforced?: boolean
  /** Resume this persisted session instead of starting a new one. */
  resumeFrom?: string
  /** Skip the staleness gate — only ever set from an explicit user choice. */
  force?: boolean
  /** Explicit key from `--api-key`; otherwise resolved from env/auth. */
  apiKey?: string
  /** Initial task from `vajra run "…"` — skips the first prompt. */
  initialTask?: string
  /** Max parallel workers (`vajra run -c`). */
  concurrency?: number
}
