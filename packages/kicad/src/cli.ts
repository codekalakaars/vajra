// kicad-cli wrapper.
//
// Provides typed functions for calling kicad-cli commands. All functions
// throw on non-zero exit codes and parse JSON output where applicable.
//
// Requires kicad-cli to be installed and on PATH.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Check if kicad-cli is available on the system */
export async function isKicadCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('kicad-cli', ['version'])
    return true
  } catch {
    return false
  }
}

/** Get kicad-cli version string */
export async function getVersion(): Promise<string> {
  const { stdout } = await execFileAsync('kicad-cli', ['version'])
  return stdout.trim()
}

/** Run a kicad-cli command and return stdout */
export async function run(
  command: string,
  subcommand: string,
  args: string[],
): Promise<string> {
  const { stdout, stderr } = await execFileAsync('kicad-cli', [command, subcommand, ...args])
  if (stderr && !stdout) {
    throw new Error(`kicad-cli ${command} ${subcommand} failed: ${stderr}`)
  }
  return stdout
}

/** Run a kicad-cli command that writes to a file */
export async function runToFile(
  command: string,
  subcommand: string,
  args: string[],
): Promise<void> {
  // promisify(execFile) rejects on non-zero exit codes.
  // stderr may contain warnings/info messages even on success — ignore them.
  await execFileAsync('kicad-cli', [command, subcommand, ...args])
}

// ---------------------------------------------------------------------------
// Schematic commands
// ---------------------------------------------------------------------------

/** Export netlist from a schematic */
export async function exportNetlist(
  schPath: string,
  outputPath: string,
): Promise<void> {
  await runToFile('sch', 'export', ['netlist', schPath, '--output', outputPath])
}

/** Export BOM from a schematic */
export async function exportBom(
  schPath: string,
  outputPath: string,
): Promise<void> {
  await runToFile('sch', 'export', ['bom', schPath, '--output', outputPath])
}

/** Export a schematic to PDF */
export async function exportSchPdf(
  schPath: string,
  outputPath: string,
): Promise<void> {
  await runToFile('sch', 'export', ['pdf', schPath, '--output', outputPath])
}

// ---------------------------------------------------------------------------
// PCB commands
// ---------------------------------------------------------------------------

/** Run Design Rule Check on a PCB */
export async function runDrc(
  pcbPath: string,
  outputPath: string,
): Promise<void> {
  await runToFile('pcb', 'drc', [pcbPath, '--output', outputPath])
}

/** Export Gerber files from a PCB */
export async function exportGerbers(
  pcbPath: string,
  outputDir: string,
): Promise<void> {
  await runToFile('pcb', 'export', ['gerbers', pcbPath, '--output', outputDir])
}

/** Export drill files from a PCB */
export async function exportDrill(
  pcbPath: string,
  outputDir: string,
): Promise<void> {
  await runToFile('pcb', 'export', ['drill', pcbPath, '--output', outputDir])
}

/** Export a PCB to PDF */
export async function exportPcbPdf(
  pcbPath: string,
  outputPath: string,
): Promise<void> {
  await runToFile('pcb', 'export', ['pdf', pcbPath, '--output', outputPath])
}

/** Export a PCB to SVG */
export async function exportPcbSvg(
  pcbPath: string,
  outputDir: string,
): Promise<void> {
  await runToFile('pcb', 'export', ['svg', pcbPath, '--output', outputDir])
}

/** Export 3D model (STEP) */
export async function exportStep(
  pcbPath: string,
  outputPath: string,
): Promise<void> {
  await runToFile('pcb', 'export', ['step', pcbPath, '--output', outputPath])
}

/** Export 3D model (GLB) */
export async function exportGlb(
  pcbPath: string,
  outputPath: string,
): Promise<void> {
  await runToFile('pcb', 'export', ['glb', pcbPath, '--output', outputPath])
}
