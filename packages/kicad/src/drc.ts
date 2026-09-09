// DRC (Design Rule Check) wrapper.
//
// Runs kicad-cli pcb drc and parses the JSON report.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { runDrc as cliRunDrc } from './cli.js'

/** A single DRC violation */
export interface DrcViolation {
  /** Violation type (e.g. "clearance", "track_width", "via_diameter") */
  type: string
  /** Severity (error, warning) */
  severity: 'error' | 'warning'
  /** Description of the violation */
  message: string
  /** Location (x, y) if applicable */
  location?: { x: number; y: number }
  /** Affected items */
  items?: string[]
}

/** DRC report */
export interface DrcReport {
  /** Whether the design passed DRC */
  passed: boolean
  /** Total number of violations */
  violationCount: number
  /** Number of errors (must-fix) */
  errorCount: number
  /** Number of warnings */
  warningCount: number
  /** List of violations */
  violations: DrcViolation[]
}

/**
 * Run DRC on a .kicad_pcb file and return the report.
 */
export async function runDrc(pcbPath: string): Promise<DrcReport> {
  const tmpFile = join(tmpdir(), `vajra-drc-${randomUUID()}.json`)
  try {
    await cliRunDrc(pcbPath, tmpFile)
    const content = await readFile(tmpFile, 'utf-8')
    return parseDrcReport(content)
  } catch (e) {
    // kicad-cli may exit non-zero on DRC errors — that's expected
    // Try to read the report file anyway
    try {
      const content = await readFile(tmpFile, 'utf-8')
      return parseDrcReport(content)
    } catch {
      throw new Error(`DRC failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

function parseDrcReport(content: string): DrcReport {
  try {
    const data = JSON.parse(content)
    const violations: DrcViolation[] = []
    let errorCount = 0
    let warningCount = 0

    // Parse violations from the report
    if (data.violations) {
      for (const v of data.violations) {
        const severity = v.severity === 'error' ? 'error' : 'warning'
        if (severity === 'error') errorCount++
        else warningCount++

        violations.push({
          type: v.type || 'unknown',
          severity,
          message: v.message || v.description || '',
          location: v.location,
          items: v.items,
        })
      }
    }

    return {
      passed: errorCount === 0,
      violationCount: violations.length,
      errorCount,
      warningCount,
      violations,
    }
  } catch {
    // If JSON parsing fails, try to extract info from text
    return {
      passed: false,
      violationCount: 0,
      errorCount: 0,
      warningCount: 0,
      violations: [],
    }
  }
}
