import type { WorkLedgerEntry } from './context-types.js'

/**
 * What one attempt did, recorded by the runtime as it happened.
 *
 * This is the half of the record that cannot be asked for. A model asked what it
 * did will summarise; a model asked for the commands it ran and the files it
 * wrote can only answer, because the harness ran them. Every checkpoint,
 * handoff and respawn context in the context batches is joined with this, so a
 * model that omits something important still has it.
 *
 * It is written from the loop's own observation of each call — the arguments as
 * the model sent them and the result the harness returned — never from the
 * model's later description of the same call.
 */

/** Tools that change a file, and so make the ledger's `mutated` true. */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'create_dir'])

/** The C1 payload `run_command` returns: `{ exitCode, signal, stdout, stderr }`. */
function exitCodeOf(content: string): number | undefined {
  try {
    const parsed = JSON.parse(content) as { exitCode?: unknown }
    return typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined
  } catch {
    // Not a command result (a masked stub, an error string): no exit code.
    return undefined
  }
}

export interface LedgerCall {
  round: number
  callId: string
  tool: string
  args: unknown
  content: string
  ok: boolean
}

export class WorkLedger {
  private entries: WorkLedgerEntry[] = []
  private byCall = new Map<string, WorkLedgerEntry>()

  /** Record one finished tool call, with everything the runtime saw of it. */
  record(call: LedgerCall): WorkLedgerEntry {
    const a = (call.args ?? {}) as Record<string, unknown>
    const path = typeof a.path === 'string' ? a.path : undefined
    const command =
      typeof a.command === 'string'
        ? a.command
        : Array.isArray(a.argv)
          ? a.argv.map(String).join(' ')
          : undefined
    const entry: WorkLedgerEntry = {
      round: call.round,
      tool: call.tool,
      ...(path !== undefined ? { path } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(command !== undefined ? { exitCode: exitCodeOf(call.content) ?? -1 } : {}),
      mutated: call.ok && MUTATING_TOOLS.has(call.tool),
      ok: call.ok,
    }
    this.entries.push(entry)
    this.byCall.set(call.callId, entry)
    return entry
  }

  get all(): readonly WorkLedgerEntry[] {
    return this.entries
  }

  /** The entry a tool result came from, or undefined when it is not ours. */
  forCall(callId: string): WorkLedgerEntry | undefined {
    return this.byCall.get(callId)
  }

  /** Position of an entry, used to ask "was this superseded by something later". */
  private indexOf(entry: WorkLedgerEntry): number {
    return this.entries.indexOf(entry)
  }

  /** Whether a later call touched the same path: an edit, or a re-read. */
  supersededBy(entry: WorkLedgerEntry): boolean {
    const at = this.indexOf(entry)
    if (at < 0 || entry.path === undefined) return false
    return this.entries
      .slice(at + 1)
      .some(later => later.path === entry.path && (later.tool === 'read_file' || later.mutated))
  }

  /** Whether a later call ran the same command. */
  rerunAfter(entry: WorkLedgerEntry): boolean {
    const at = this.indexOf(entry)
    if (at < 0 || entry.command === undefined) return false
    return this.entries.slice(at + 1).some(later => later.command === entry.command)
  }

  /** Every path a call changed, in the order it was changed. */
  filesWritten(): string[] {
    const out: string[] = []
    for (const entry of this.entries) {
      if (entry.mutated && entry.path !== undefined && !out.includes(entry.path)) out.push(entry.path)
    }
    return out
  }

  /** The last command and how it ended, which is what a checkpoint records. */
  lastVerification(): { command: string; exitCode: number } | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]
      if (entry.command === undefined) continue
      return { command: entry.command, exitCode: entry.exitCode ?? -1 }
    }
    return undefined
  }

  /**
   * Every command it ran and how each ended, for the ledger summary a
   * compaction carries. Runtime-owned, and the reason a checkpoint cannot claim
   * a test passed that never ran.
   */
  commands(): Array<{ command: string; exitCode: number }> {
    return this.entries
      .filter(entry => entry.command !== undefined)
      .map(entry => ({ command: entry.command as string, exitCode: entry.exitCode ?? -1 }))
  }

  /** The same thing as one line each, which is how a compaction shows it. */
  commandSummary(): string[] {
    return this.commands().map(({ command, exitCode }) => `${command} → exit ${exitCode}`)
  }
}