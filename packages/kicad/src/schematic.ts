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
      value: (match[2] || '').replace(/^"|"$/g, ''),
      footprint: match[3] || '',
      symbol: (match[4] || '').replace(/^"|"$/g, ''),
      connections: {},
    })
  }

  // If regex didn't match (complex netlists), use line-based parsing
  if (components.length === 0) {
    return parseNetlistFallback(content)
  }

  // Parse nets using balanced-paren extraction to capture ALL nodes
  const netsStart = content.indexOf('(nets')
  if (netsStart !== -1) {
    let depth = 0
    let netsBody = ''
    let inNets = false
    for (let i = netsStart; i < content.length; i++) {
      if (content[i] === '(') {
        depth++
        if (depth === 1) inNets = true
      } else if (content[i] === ')') {
        depth--
        if (depth === 0 && inNets) {
          netsBody = content.slice(netsStart, i + 1)
          break
        }
      }
    }

    // Extract individual net blocks
    const netBlockRegex = /\(net \(code (\d+)\) \(name "([^"]*)"\)\s*([\s\S]*?)\)\s*(?=\(net |\))/g
    let netMatch
    while ((netMatch = netBlockRegex.exec(netsBody)) !== null) {
      const netName = netMatch[2]
      const netCode = parseInt(netMatch[1], 10)
      const body = netMatch[3]

      // Parse ALL nodes from the body
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

  // Extract component blocks using balanced parens
  const compSections = extractSections(content, 'comp')
  for (const section of compSections) {
    const refMatch = section.match(/\(ref (\w+)\)/)
    const valMatch = section.match(/\(value "([^"]*)"\)/)
    const fpMatch = section.match(/\(footprint "([^"]*)"\)/)
    const symMatch = section.match(/\(libsymbol ([^)]*)\)/)
    if (refMatch) {
      components.push({
        reference: refMatch[1],
        value: valMatch ? valMatch[1] : '',
        footprint: fpMatch ? fpMatch[1] : '',
        symbol: symMatch ? symMatch[1].replace(/^"|"$/g, '') : '',
        connections: {},
      })
    }
  }

  // Extract net blocks using balanced parens
  const netSections = extractSections(content, 'net')
  for (const section of netSections) {
    const codeMatch = section.match(/\(code (\d+)\)/)
    const nameMatch = section.match(/\(name "([^"]*)"\)/)
    if (!codeMatch || !nameMatch) continue

    const netName = nameMatch[1]
    const netCode = parseInt(codeMatch[1], 10)
    const componentRefs: string[] = []

    // Parse nodes
    const nodeRegex = /\(node \(ref (\w+)\)(?:\(pin ([^)]*)\))?\)/g
    let nodeMatch
    while ((nodeMatch = nodeRegex.exec(section)) !== null) {
      componentRefs.push(nodeMatch[1])
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

/** Extract balanced S-expression sections for a given tag */
function extractSections(content: string, tag: string): string[] {
  const sections: string[] = []
  const prefix = `(${tag} `
  let searchFrom = 0

  while (true) {
    const start = content.indexOf(prefix, searchFrom)
    if (start === -1) break

    // Find the matching closing paren
    let depth = 0
    let end = -1
    for (let i = start; i < content.length; i++) {
      if (content[i] === '(') depth++
      else if (content[i] === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }

    if (end !== -1) {
      sections.push(content.slice(start, end + 1))
      searchFrom = end + 1
    } else {
      break
    }
  }

  return sections
}
