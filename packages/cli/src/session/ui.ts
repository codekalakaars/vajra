import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'

/** Streaming/output methods shared by runSession and executeTask. */
export interface SessionStreamer {
  onTextDelta(text: string): void
  onThinkingDelta(text: string): void
  /** Flush buffered assistant text. */
  finishLine(): void
  /** Drop unflushed buffer without printing. */
  discardBuffer(): void
  info(message: string): void
  success(message: string): void
  error(message: string): void
  warning(message: string): void
  /** Blank line (report separators). */
  newline(): void
}

/** Structured execution progress so frontends can render a task list. */
export type TaskEvent =
  | { type: 'start'; index: number; total: number; title: string }
  | { type: 'done'; title: string }
  | { type: 'failed'; title: string }
  | { type: 'skipped'; title: string }
  | { type: 'retry'; title: string; attempt: number; max: number }
  | { type: 'no-changes'; title: string }

/**
 * Port implemented by frontends (CLI readline adapter, TUI). runSession talks
 * to the UI only through this interface — no readline, no console, no Ink.
 */
export interface SessionUI extends SessionStreamer {
  banner(): void
  /**
   * Initial task prompt when none was passed on the command line.
   * 'first' = "What would you like me to work on?",
   * 'reentry' = empty answer loop: "Please enter a task (or type "exit")".
   */
  askInitialTask(kind: 'first' | 'reentry'): Promise<string>
  /** Follow-up user turn during the conversation loop. */
  askUserMessage(): Promise<string>
  /** Render the proposed plan before confirmation. */
  showPlan(plan: DeveloperPlan): void
  /** Ask [y/N] for the plan. Anything but y/yes must come back as 'n'. */
  askConfirmPlan(): Promise<'y' | 'n'>
  /** Ask for feedback after a rejected plan. */
  askRejectFeedback(): Promise<string>
  /** Task execution progress (CLI maps this back to log lines). */
  onTaskEvent(event: TaskEvent): void
}
