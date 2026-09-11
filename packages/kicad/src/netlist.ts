// Netlist export from schematic.
//
// Thin wrapper around kicad-cli's netlist export. The netlist is an
// intermediate representation between schematic and PCB.

import { readFile } from 'node:fs/promises'
import { exportNetlist as cliExportNetlist } from './cli.js'

/**
 * Export a netlist from a .kicad_sch file and return parsed data.
 */
export async function exportNetlist(schPath: string, outputPath?: string): Promise<string> {
  const target = outputPath ?? schPath.replace(/\.kicad_sch$/, '.net')
  await cliExportNetlist(schPath, target)
  return readFile(target, 'utf-8')
}
