// Basic trace routing.
//
// v1: Generates unrouted connections (ratsnest). Full autorouting is
// complex and better left to KiCad's interactive router. This module
// creates the net connections that KiCad will route.

import type { PlacedFootprint } from './placement.js'
import type { SchematicNet } from './schematic.js'

/** An unrouted connection (ratsnest line) */
export interface UnroutedConnection {
  /** Net name */
  net: string
  /** Start pad (component:pin) */
  from: { component: string; pin: string }
  /** End pad (component:pin) */
  to: { component: string; pin: string }
}

/**
 * Generate unrouted connections from placed footprints and nets.
 *
 * These are the "ratsnest" lines that KiCad shows before routing.
 * The actual routing is done by KiCad's interactive router when the
 * user opens the .kicad_pcb file.
 */
export function generateUnroutedConnections(
  placed: PlacedFootprint[],
  nets: SchematicNet[],
): UnroutedConnection[] {
  const connections: UnroutedConnection[] = []
  const placedSet = new Set(placed.map((p) => p.reference))

  for (const net of nets) {
    // Only include nets where all components are placed
    const placedComponents = net.components.filter((ref) => placedSet.has(ref))
    if (placedComponents.length < 2) continue

    // Generate connections between consecutive components in the net
    for (let i = 0; i < placedComponents.length - 1; i++) {
      connections.push({
        net: net.name,
        from: { component: placedComponents[i], pin: '' },
        to: { component: placedComponents[i + 1], pin: '' },
      })
    }
  }

  return connections
}
