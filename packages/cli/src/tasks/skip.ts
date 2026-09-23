import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runCommandAsync } from '../native.js'
import { tokenizeCommand } from '../tools/handle.js'

export interface SkipEvaluation {
  shouldSkip: boolean
  warnings: string[]
}

/**
 * Evaluate skipIf conditions.
 *
 * - All recognised conditions must pass for the task to skip.
 * - An unrecognised condition warns and is ignored (never forces a skip).
 * - If nothing recognised, do not skip.
 */
export async function evaluateSkipIfDetailed(
  conditions: string[],
  projectDir: string,
): Promise<SkipEvaluation> {
  const warnings: string[] = []
  if (conditions.length === 0) {
    return { shouldSkip: false, warnings }
  }

  let recognized = 0
  let allPassed = true

  for (const condition of conditions) {
    const trimmed = condition.trim()
    const lower = trimmed.toLowerCase()

    if (lower.startsWith('file exists:')) {
      recognized++
      const filePath = trimmed.slice('file exists:'.length).trim()
      const fullPath = resolve(projectDir, filePath)
      try {
        await access(fullPath)
      } catch {
        allPassed = false
      }
      continue
    }

    if (lower.startsWith('file missing:')) {
      recognized++
      const filePath = trimmed.slice('file missing:'.length).trim()
      const fullPath = resolve(projectDir, filePath)
      try {
        await access(fullPath)
        allPassed = false
      } catch {
        // missing — condition holds
      }
      continue
    }

    if (lower.startsWith('command passes:')) {
      recognized++
      const cmd = trimmed.slice('command passes:'.length).trim()
      const tokenized = tokenizeCommand(cmd)
      if (!tokenized.ok) {
        warnings.push(`skipIf command invalid (${tokenized.error}); treating as not-passing`)
        allPassed = false
        continue
      }
      try {
        const [name, ...args] = tokenized.argv
        const result = await runCommandAsync(name, args, projectDir)
        if (result.code !== 0) {
          allPassed = false
        }
      } catch {
        allPassed = false
      }
      continue
    }

    warnings.push(`Unknown skipIf condition '${trimmed}' — ignored (task will not skip on it)`)
  }

  if (recognized === 0 || !allPassed) {
    return { shouldSkip: false, warnings }
  }
  return { shouldSkip: true, warnings }
}

/** Back-compat helper: true only when every recognised condition holds. */
export async function evaluateSkipIf(conditions: string[], projectDir: string): Promise<boolean> {
  const result = await evaluateSkipIfDetailed(conditions, projectDir)
  for (const w of result.warnings) {
    console.warn(`⚠ ${w}`)
  }
  return result.shouldSkip
}
