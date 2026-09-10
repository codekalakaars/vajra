// PCB footprint placement algorithm.
//
// Places component footprints on the board based on connectivity
// and spatial heuristics. The goal is to minimize total trace length
// and keep related components close together.

import type { ParsedSchematic, SchematicComponent, SchematicNet } from './schematic.js'
import type { BoardConstraints, Point } from './constraints.js'

/** A placed footprint with position */
export interface PlacedFootprint {
  reference: string
  value: string
  footprint: string
  /** Center position (mm) */
  x: number
  y: number
  /** Rotation in degrees */
  rotation: number
  /** Which layer (F.Cu or B.Cu) */
  layer: 'F.Cu' | 'B.Cu'
}

/** Build a connectivity graph from nets */
function buildConnectivityGraph(nets: SchematicNet[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>()

  for (const net of nets) {
    for (const ref of net.components) {
      if (!graph.has(ref)) graph.set(ref, new Set())
      for (const other of net.components) {
        if (other !== ref) {
          graph.get(ref)!.add(other)
        }
      }
    }
  }

  return graph
}

/** Calculate net weight (more connections = higher priority to be close) */
function netWeight(
  ref: string,
  graph: Map<string, Set<string>>,
): number {
  return graph.get(ref)?.size ?? 0
}

/**
 * Place footprints on the board.
 *
 * Strategy:
 * 1. Sort components by connectivity (most connected first)
 * 2. Place ICs/large components in the center
 * 3. Place passives near their connected ICs
 * 4. Place connectors at board edges
 * 5. Use grid-based placement with collision avoidance
 */
export function placeFootprints(
  schematic: ParsedSchematic,
  constraints: BoardConstraints,
): PlacedFootprint[] {
  // Validate board constraints
  if (constraints.width <= 0) throw new Error(`Board width must be > 0, got ${constraints.width}`)
  if (constraints.height <= 0) throw new Error(`Board height must be > 0, got ${constraints.height}`)
  if (![1, 2, 4].includes(constraints.layers)) throw new Error(`layers must be 1, 2, or 4, got ${constraints.layers}`)

  const graph = buildConnectivityGraph(schematic.nets)
  const placed: PlacedFootprint[] = []
  const occupied = new Set<string>()

  const margin = 5 // mm from board edge
  const gridStep = 2.54 // mm (standard pitch)

  const boardWidth = constraints.width - margin * 2
  const boardHeight = constraints.height - margin * 2

  // Sort by connectivity (most connected first)
  const sorted = [...schematic.components].sort((a, b) => {
    return netWeight(b.reference, graph) - netWeight(a.reference, graph)
  })

  // Classify components
  const ics = sorted.filter((c) => isIC(c))
  const connectors = sorted.filter((c) => isConnector(c))
  const decouplingCaps = sorted.filter((c) => isDecouplingCap(c) && !isIC(c) && !isConnector(c))
  const others = sorted.filter((c) => !isIC(c) && !isConnector(c) && !isDecouplingCap(c))

  // Place ICs in center area
  const icCols = Math.ceil(Math.sqrt(ics.length))
  const icSpacingX = boardWidth / (icCols + 1)
  const icSpacingY = boardHeight / (Math.ceil(ics.length / icCols) + 1)

  for (let i = 0; i < ics.length; i++) {
    const col = i % icCols
    const row = Math.floor(i / icCols)
    const x = margin + icSpacingX * (col + 1)
    const y = margin + icSpacingY * (row + 1)

    const pos = snapToGrid(x, y, gridStep)
    if (!isOccupied(pos.x, pos.y, occupied)) {
      placed.push({
        reference: ics[i].reference,
        value: ics[i].value,
        footprint: ics[i].footprint,
        x: pos.x,
        y: pos.y,
        rotation: 0,
        layer: 'F.Cu',
      })
      occupied.add(pointKey(pos.x, pos.y))
    }
  }

  // Place connectors at board edges
  for (let i = 0; i < connectors.length; i++) {
    const edge = i % 4 // top, right, bottom, left
    let x: number, y: number

    switch (edge) {
      case 0: // top
        x = margin + (boardWidth / (connectors.length + 1)) * (i + 1)
        y = margin
        break
      case 1: // right
        x = constraints.width - margin
        y = margin + (boardHeight / (connectors.length + 1)) * (i + 1)
        break
      case 2: // bottom
        x = margin + (boardWidth / (connectors.length + 1)) * (i + 1)
        y = constraints.height - margin
        break
      default: // left
        x = margin
        y = margin + (boardHeight / (connectors.length + 1)) * (i + 1)
        break
    }

    const pos = snapToGrid(x, y, gridStep)
    if (!isOccupied(pos.x, pos.y, occupied)) {
      placed.push({
        reference: connectors[i].reference,
        value: connectors[i].value,
        footprint: connectors[i].footprint,
        x: pos.x,
        y: pos.y,
        rotation: edge === 1 || edge === 3 ? 90 : 0,
        layer: 'F.Cu',
      })
      occupied.add(pointKey(pos.x, pos.y))
    }
  }

  // Place decoupling caps on B.Cu near their connected ICs (2+ layer boards)
  if (constraints.layers >= 2) {
    for (const comp of decouplingCaps) {
      const connected = graph.get(comp.reference) ?? new Set()
      let bestX = boardWidth / 2 + margin
      let bestY = boardHeight / 2 + margin

      // Find the centroid of connected ICs (prefer placing near ICs)
      let sumX = 0, sumY = 0, count = 0
      for (const placedComp of placed) {
        if (connected.has(placedComp.reference) && isIC({ reference: placedComp.reference, value: placedComp.value, footprint: placedComp.footprint, symbol: '', connections: {} })) {
          sumX += placedComp.x
          sumY += placedComp.y
          count++
        }
      }

      if (count > 0) {
        bestX = sumX / count
        bestY = sumY / count
      }

      // Find nearest free grid point on B.Cu
      const pos = findNearestFree(bestX, bestY, gridStep, margin, constraints, occupied)
      placed.push({
        reference: comp.reference,
        value: comp.value,
        footprint: comp.footprint,
        x: pos.x,
        y: pos.y,
        rotation: 0,
        layer: 'B.Cu',
      })
      occupied.add(pointKey(pos.x, pos.y))
    }
  }

  // Place other components near their connected ICs
  // On 2+ layer boards, alternate some passives to B.Cu for density
  let bCuBudget = constraints.layers >= 2 ? Math.ceil(others.length * 0.3) : 0

  for (const comp of others) {
    const connected = graph.get(comp.reference) ?? new Set()
    let bestX = boardWidth / 2 + margin
    let bestY = boardHeight / 2 + margin

    // Find the centroid of connected placed components
    let sumX = 0, sumY = 0, count = 0
    for (const placedComp of placed) {
      if (connected.has(placedComp.reference)) {
        sumX += placedComp.x
        sumY += placedComp.y
        count++
      }
    }

    if (count > 0) {
      bestX = sumX / count
      bestY = sumY / count
    }

    // Assign layer: alternate some passives to B.Cu for better density
    const layer: 'F.Cu' | 'B.Cu' = bCuBudget > 0 ? 'B.Cu' : 'F.Cu'
    if (bCuBudget > 0) bCuBudget--

    // Find nearest free grid point
    const pos = findNearestFree(bestX, bestY, gridStep, margin, constraints, occupied)
    placed.push({
      reference: comp.reference,
      value: comp.value,
      footprint: comp.footprint,
      x: pos.x,
      y: pos.y,
      rotation: layer === 'B.Cu' ? 180 : 0,
      layer,
    })
    occupied.add(pointKey(pos.x, pos.y))
  }

  return placed
}

export function isIC(comp: SchematicComponent): boolean {
  const val = comp.value.toLowerCase()
  const sym = comp.symbol.toLowerCase()
  // Match IC indicators as whole words or at start followed by non-alpha
  return /\b(ic|mcu|cpu|fpga|dsp|soc)\b/.test(val) ||
    /\b(stm32|atmega|esp32|samd|nrf|rp2040)\b/.test(val) ||
    /(?:^|[:_])(ic|mcu)(?:[_:]|$)/.test(sym)
}

export function isConnector(comp: SchematicComponent): boolean {
  const val = comp.value.toLowerCase()
  const sym = comp.symbol.toLowerCase()
  const fp = comp.footprint.toLowerCase()
  return val.includes('conn') || val.includes('header') || val.includes('usb') ||
    val.includes('jack') || val.includes('socket') ||
    sym.includes('conn') || sym.includes('header') ||
    fp.includes('conn') || fp.includes('header') || fp.includes('usb')
}

/** Identify power regulation components (regulators, converters, LDOs) */
export function isPower(comp: SchematicComponent): boolean {
  const val = comp.value.toLowerCase()
  const sym = comp.symbol.toLowerCase()
  return /\b(ldo|reg|buck|boost|converter|regulator)\b/.test(val) ||
    /\blm[127]\d+\b/.test(val) ||
    /\btps\d+\b/.test(val) ||
    /\bap[27]\d+\b/.test(val) ||
    /\bmic[27]\d+\b/.test(val) ||
    /\bams\d+\b/.test(val) ||
    /(?:^|[:_])(power|reg|dc.dc|switching)(?:[_:]|$)/.test(sym)
}

/** Identify decoupling capacitors (small value caps near ICs) */
export function isDecouplingCap(comp: SchematicComponent): boolean {
  if (!comp.footprint.toLowerCase().includes('cap')) return false
  const val = comp.value.toLowerCase()
  // Common decoupling values: 100nF, 10nF, 1nF, 10uF, 1uF
  return /\b(100nf|10nf|1nf|10uf|1uf|0.1uf|0.01uf)\b/.test(val) ||
    /\bdecoupl\b/.test(val) ||
    /\b(bypass|decoupling)\b/.test(comp.symbol.toLowerCase())
}

function snapToGrid(x: number, y: number, step: number): Point {
  return {
    x: Math.round(x / step) * step,
    y: Math.round(y / step) * step,
  }
}

function pointKey(x: number, y: number): string {
  return `${x.toFixed(2)},${y.toFixed(2)}`
}

function isOccupied(x: number, y: number, occupied: Set<string>): boolean {
  return occupied.has(pointKey(x, y))
}

function findNearestFree(
  cx: number,
  cy: number,
  step: number,
  margin: number,
  constraints: BoardConstraints,
  occupied: Set<string>,
): Point {
  // Spiral outward from (cx, cy) to find nearest free grid point
  for (let radius = 0; radius < Math.max(constraints.width, constraints.height); radius += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dy = -radius; dy <= radius; dy += step) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue
        const x = cx + dx
        const y = cy + dy
        if (x >= margin && x <= constraints.width - margin &&
            y >= margin && y <= constraints.height - margin &&
            !isOccupied(x, y, occupied)) {
          return { x, y }
        }
      }
    }
  }
  // Fallback: center of board
  return { x: constraints.width / 2, y: constraints.height / 2 }
}
