// End-to-end orchestration: circuit description → schematic → PCB.
//
// Chains together the full pipeline:
// 1. Build ParsedSchematic from structured circuit description
// 2. Generate .kicad_sch (schematic file)
// 3. Place footprints on PCB
// 4. Generate unrouted connections (ratsnest)
// 5. Generate .kicad_pcb (PCB file)
//
// This is the main entry point for the text_to_schematic tool.

import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { buildSchematicFromDescription, validateCircuitDescription } from './circuit-builder.js'
import { generateSchContent } from './schematic-generator.js'
import { placeFootprints } from './placement.js'
import { generateUnroutedConnections } from './routing.js'
import { generatePcbContent } from './pcb-generator.js'
import { resolveDesignRules } from './constraints.js'
import type { ParsedSchematic } from './schematic.js'
import type { BoardConstraints } from './constraints.js'
import type { CircuitDescription } from './circuit-builder.js'

/** Output from the full pipeline */
export interface PipelineResult {
  /** The parsed schematic (can be used for further processing) */
  schematic: ParsedSchematic
  /** Path to the generated .kicad_sch file */
  schPath: string
  /** Path to the generated .kicad_pcb file */
  pcbPath: string
  /** Number of components */
  componentCount: number
  /** Number of nets */
  netCount: number
  /** Number of unrouted connections */
  connectionCount: number
}

/** Default board constraints */
const DEFAULT_CONSTRAINTS: BoardConstraints = {
  width: 100,
  height: 80,
  layers: 2,
}

/**
 * Run the full circuit → schematic → PCB pipeline.
 *
 * @param description - Structured circuit description with components and nets
 * @param projectDir - Directory to write output files to
 * @param constraints - Optional board constraints (defaults to 100x80mm, 2-layer)
 * @returns Pipeline result with file paths and metadata
 */
export async function runPipeline(
  description: CircuitDescription,
  projectDir: string,
  constraints?: Partial<BoardConstraints>,
): Promise<PipelineResult> {
  // Validate input
  const errors = validateCircuitDescription(description)
  if (errors.length > 0) {
    throw new Error(`Invalid circuit description: ${errors.join('; ')}`)
  }

  // Build parsed schematic
  const schematic = buildSchematicFromDescription(description)

  // Generate schematic file content
  const schContent = await generateSchContent(schematic)

  // Apply default constraints
  const boardConstraints: BoardConstraints = {
    width: constraints?.width ?? DEFAULT_CONSTRAINTS.width,
    height: constraints?.height ?? DEFAULT_CONSTRAINTS.height,
    layers: constraints?.layers ?? DEFAULT_CONSTRAINTS.layers,
  }

  // Place footprints
  const placed = placeFootprints(schematic, boardConstraints)

  // Generate unrouted connections
  const connections = generateUnroutedConnections(placed, schematic.nets)

  // Generate PCB file content
  const designRules = resolveDesignRules(boardConstraints.designRules)
  const pcbContent = generatePcbContent(schematic, placed, connections, boardConstraints, designRules)

  // Write output files to disk
  await mkdir(projectDir, { recursive: true })
  const schPath = join(projectDir, 'design.kicad_sch')
  const pcbPath = join(projectDir, 'design.kicad_pcb')
  await Promise.all([
    writeFile(schPath, schContent, 'utf-8'),
    writeFile(pcbPath, pcbContent, 'utf-8'),
  ])

  return {
    schematic,
    schPath,
    pcbPath,
    componentCount: schematic.componentCount,
    netCount: schematic.netCount,
    connectionCount: connections.length,
  }
}
