// BOM (Bill of Materials) export wrapper.
//
// Runs kicad-cli to export a BOM from a schematic.

import { readFile } from 'node:fs/promises'
import { exportBom as cliExportBom } from './cli.js'

/** A single BOM line item */
export interface BomEntry {
  reference: string
  value: string
  footprint: string
  quantity: number
}

/**
 * Export a BOM from a .kicad_sch file.
 *
 * Returns the raw CSV content. The agent can present this to the user
 * or process it further.
 */
export async function exportBom(
  schPath: string,
  outputPath: string,
): Promise<string> {
  await cliExportBom(schPath, outputPath)
  return readFile(outputPath, 'utf-8')
}
