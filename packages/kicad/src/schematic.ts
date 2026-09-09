// Parse a .kicad_sch file to extract components, nets, and connections.
//
// Uses kicad-cli to export the netlist, then parses the netlist format
// to extract structured data. This is the first step in the schematic → PCB flow.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { exportNetlist } from './cli.js'

/** A component instance from the schematic */
export interface SchematicComponent {
  /** Reference designator (e.g. "R1", "C3", "U2") */
  reference: string
  /** Component value (e.g. "10k", "100nF", "ATmega328P") */
  value: string
  /** KiCad library identifier (e.g. "Device:R") */
  footprint: string
  /** Symbol library ID */
  symbol: string
  /** Pin connections: net name → pin name */
  connections: Record<string, string>
}

/** A net from the schematic */
export interface SchematicNet {
  /** Net name (e.g. "VCC", "GND", "D0") */
  name: string
  /** Net code (numeric) */
  code: number
  /** Component references connected to this net */
  components: string[]
}

/** Parsed schematic data */
export interface ParsedSchematic {
  /** All components in the schematic */
  components: SchematicComponent[]
  /** All nets in the schematic */
  nets: SchematicNet[]
  /** Component count */
  componentCount: number
  /** Net count */
  netCount: number
}

/**
 * Parse a .kicad_sch file by exporting its netlist and parsing the result.
 *
 * Uses kicad-cli to export a .net file, then parses the netlist format
 * to extract components and nets.
 */
export async function parseSchematic(schPath: string): Promise<ParsedSchematic> {
  // Export netlist to a temp file
  const tmpFile = join(tmpdir(), `vajra-netlist-${randomUUID()}.net`)
  try {
    await exportNetlist(schPath, tmpFile)
    const netlistContent = await readFile(tmpFile, 'utf-8')
    return parseNetlist(netlistContent)
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

/**
 * Parse a KiCad netlist (.net) format string into structured data.
 *
 * The netlist format is S-expression based:
 * (export (version D)
 *   (design
 *     (source "...")
 *     (date "...")
 *     (tool "...")
 *   )
 *   (components
 *     (comp (ref R1) (value 10k) (footprint "Resistor_SMD:R_0402_1005Metric") ...)
 *   )
 *   (nets
 *     (net (code 1) (name "VCC") (node (ref U1) (pin 1)) (node (ref R1) (pin 1)))
 *   )
 * )
 */
function parseNetlist(content: string): ParsedSchematic {
  const components: SchematicComponent[] = []
  const nets: SchematicNet[] = []

  // Parse components
  const compRegex = /\(comp \(ref (\w+)\)\s*(?:\(value ([^)]*)\)\s*)?(?:\(footprint "([^"]*)"\)\s*)?(?:\(libsymbol ([^)]*)\)\s*)?(?:\([^)]*\)\s*)*\)/g
  let match
  while ((match = compRegex.exec(content)) !== null) {
    components.push({
      reference: match[1],
      value: match[2] || '',
      footprint: match[3] || '',
      symbol: match[4] || '',
      connections: {},
    })
  }

  // If regex didn't match (complex netlists), use line-based parsing
  if (components.length === 0) {
    return parseNetlistFallback(content)
  }

  // Parse nets
  const netRegex = /\(net \(code (\d+)\) \(name "([^"]*)"\)([\s\S]*?)\)/g
  while ((match = netRegex.exec(content)) !== null) {
    const netName = match[2]
    const netCode = parseInt(match[1], 10)
    const body = match[3]

    const nodeRegex = /\(node \(ref (\w+)\)(?:\(pin ([^)]*)\))?\)/g
    const componentRefs: string[] = []
    let nodeMatch
    while ((nodeMatch = nodeRegex.exec(body)) !== null) {
      componentRefs.push(nodeMatch[1])
      // Record connection on the component
      const comp = components.find((c) => c.reference === nodeMatch![1])
      if (comp && netName && nodeMatch[2]) {
        comp.connections[netName] = nodeMatch[2]
      }
    }

    if (netName !== 'UNCONNECTED') {
      nets.push({ name: netName, code: netCode, components: componentRefs })
    }
  }

  return {
    components,
    nets,
    componentCount: components.length,
    netCount: nets.length,
  }
}

/** Fallback parser for netlists that don't match the regex patterns */
function parseNetlistFallback(content: string): ParsedSchematic {
  const components: SchematicComponent[] = []
  const nets: SchematicNet[] = []

  const lines = content.split('\n')
  let currentComp: Partial<SchematicComponent> | null = null
  let currentNet: Partial<SchematicNet> | null = null

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('(comp (ref ')) {
      const refMatch = trimmed.match(/\(ref (\w+)\)/)
      if (refMatch) {
        currentComp = { reference: refMatch[1], value: '', footprint: '', symbol: '', connections: {} }
      }
    } else if (currentComp) {
      const valMatch = trimmed.match(/\(value "([^"]*)"\)/)
      if (valMatch) currentComp.value = valMatch[1]

      const fpMatch = trimmed.match(/\(footprint "([^"]*)"\)/)
      if (fpMatch) currentComp.footprint = fpMatch[1]

      const symMatch = trimmed.match(/\(libsymbol ([^)]*)\)/)
      if (symMatch) currentComp.symbol = symMatch[1]

      if (trimmed === ')') {
        components.push(currentComp as SchematicComponent)
        currentComp = null
      }
    }

    if (trimmed.startsWith('(net (code ')) {
      const codeMatch = trimmed.match(/\(code (\d+)\)/)
      const nameMatch = trimmed.match(/\(name "([^"]*)"\)/)
      if (codeMatch && nameMatch) {
        currentNet = { name: nameMatch[1], code: parseInt(codeMatch[1], 10), components: [] }
      }
    } else if (currentNet) {
      const nodeMatch = trimmed.match(/\(node \(ref (\w+)\)/)
      if (nodeMatch) {
        currentNet.components!.push(nodeMatch[1])
      }

      if (trimmed === ')' || trimmed === '))') {
        if (currentNet.name !== 'UNCONNECTED') {
          nets.push(currentNet as SchematicNet)
        }
        currentNet = null
      }
    }
  }

  return {
    components,
    nets,
    componentCount: components.length,
    netCount: nets.length,
  }
}
