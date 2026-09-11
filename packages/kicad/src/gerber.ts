// Gerber export wrapper.
//
// Runs kicad-cli to export Gerber files for PCB fabrication.

import { exportGerbers as cliExportGerbers, exportDrill as cliExportDrill } from './cli.js'

/**
 * Export Gerber and drill files from a .kicad_pcb.
 *
 * Produces all files needed for PCB fabrication:
 * - Copper layers (.gbr)
 * - Silkscreen (.gbr)
 * - Solder mask (.gbr)
 * - Paste (.gbr)
 * - Drill files (.drl)
 */
export async function exportGerbers(pcbPath: string, outputDir: string): Promise<void> {
  await Promise.all([
    cliExportGerbers(pcbPath, outputDir),
    cliExportDrill(pcbPath, outputDir),
  ])
}
