// Build a ParsedSchematic from structured circuit description.
//
// This module converts the text_to_schematic tool's structured input
// into a ParsedSchematic that can be used by the PCB generation pipeline.

import type { ParsedSchematic, SchematicComponent, SchematicNet } from './schematic.js'

/** Component input from text_to_schematic tool */
export interface CircuitComponent {
  reference: string
  value: string
  footprint: string
  symbol: string
}

/** Net input from text_to_schematic tool */
export interface CircuitNet {
  name: string
  connections: Array<{ reference: string; pin: string }>
}

/** Full circuit description from text_to_schematic tool */
export interface CircuitDescription {
  components: CircuitComponent[]
  nets: CircuitNet[]
}

/**
 * Build a ParsedSchematic from a structured circuit description.
 *
 * This converts the text_to_schematic tool's input format into the
 * ParsedSchematic format used by the PCB generation pipeline.
 */
export function buildSchematicFromDescription(description: CircuitDescription): ParsedSchematic {
  const { components: inputComponents, nets: inputNets } = description

  // Build component map for quick lookup
  const componentMap = new Map<string, CircuitComponent>()
  for (const comp of inputComponents) {
    componentMap.set(comp.reference, comp)
  }

  // Build components with connections
  const components: SchematicComponent[] = inputComponents.map((comp) => {
    const connections: Record<string, string> = {}

    // Find all nets that connect to this component
    for (const net of inputNets) {
      for (const conn of net.connections) {
        if (conn.reference === comp.reference) {
          connections[net.name] = conn.pin
        }
      }
    }

    return {
      reference: comp.reference,
      value: comp.value,
      footprint: comp.footprint,
      symbol: comp.symbol,
      connections,
    }
  })

  // Build nets
  const nets: SchematicNet[] = inputNets.map((net, index) => ({
    name: net.name,
    code: index + 1,
    components: [...new Set(net.connections.map((c) => c.reference))],
  }))

  return {
    components,
    nets,
    componentCount: components.length,
    netCount: nets.length,
  }
}

/**
 * Validate a circuit description.
 *
 * Checks for:
 * - Duplicate references
 * - Nets with < 2 connections
 * - Components referenced in nets that don't exist
 */
export function validateCircuitDescription(description: CircuitDescription): string[] {
  const errors: string[] = []
  const references = new Set<string>()

  // Check for duplicate references
  for (const comp of description.components) {
    if (references.has(comp.reference)) {
      errors.push(`Duplicate reference: ${comp.reference}`)
    }
    references.add(comp.reference)
  }

  // Check nets
  for (const net of description.nets) {
    if (net.connections.length < 2) {
      errors.push(`Net "${net.name}" has fewer than 2 connections`)
    }

    for (const conn of net.connections) {
      if (!references.has(conn.reference)) {
        errors.push(`Net "${net.name}" references unknown component: ${conn.reference}`)
      }
    }
  }

  return errors
}
