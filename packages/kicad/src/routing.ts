// Basic trace routing.
//
// v1: Generates unrouted connections (ratsnest). Full autorouting is
// complex and better left to KiCad's interactive router. This module
// creates the net connections that KiCad will route.
//
// v2: Star topology — all components in a net connect to the first
// (hub) component instead of a linear chain. This better represents
// real ratsnest behavior where all pins share a common net.

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
 * Uses star topology: all components in a net connect to the first
 * (hub) component. This better represents real ratsnest behavior
 * where all pins in a net must be connected together.
 *
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

    // Star topology: connect all components to the first (hub) component
    const hub = placedComponents[0]
    for (let i = 1; i < placedComponents.length; i++) {
      connections.push({
        net: net.name,
        from: { component: hub, pin: '' },
        to: { component: placedComponents[i], pin: '' },
      })
    }
  }

  return connections
}
