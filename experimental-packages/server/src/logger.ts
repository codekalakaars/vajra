// Structured logging via pino.
//
// Provides a single logger instance used across the server. All log entries
// are JSON-structured with consistent fields for easy parsing.

import pino from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'

export const logger = pino({
  level,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino/file', options: { destination: 1 } }
    : undefined,
})

/**
 * Create a child logger with a named component prefix.
 *
 * Usage:
 *   const log = componentLogger('ws')
 *   log.info({ sessionId }, 'client connected')
 */
export function componentLogger(component: string) {
  return logger.child({ component })
}
