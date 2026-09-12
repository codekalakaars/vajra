// Generate a .kicad_sch file from parsed schematic data.
//
// Creates a complete KiCad schematic with:
// - Embedded library symbol definitions (lib_symbols)
// - Placed component symbols on a grid layout
// - Power symbols (VCC, GND) for power nets
// - Wires connecting pins within each net
// - Net labels for clarity
//
// The generated file can be opened directly in KiCad's schematic editor.

import { writeFile } from 'node:fs/promises'
import type { ParsedSchematic, SchematicComponent, SchematicNet } from './schematic.js'
import type { SymbolResolver, ResolvedSymbol, ResolvedPin } from './symbol-lib.js'

/** Layout options for schematic generation */
export interface SchLayoutOptions {
  /** Page size (default: "A4") */
  paper?: string
  /** Horizontal spacing between components in mm (default: 25.4) */
  spacingX?: number
  /** Vertical spacing between rows in mm (default: 25.4) */
  spacingY?: number
  /** Components per row before wrapping (default: 6) */
  cols?: number
  /** Project name for instance tracking (default: "vajra") */
  projectName?: string
  /** Symbol resolver for library lookups (optional — falls back to embedded symbols) */
  resolver?: SymbolResolver
}

interface PlacedSymbol {
  component: SchematicComponent
  x: number
  y: number
  rotation: number
  pinCoords: Map<string, { x: number; y: number }> // pin number → absolute coords
  resolvedSymbol: ResolvedSymbol | null
}

interface WireSegment {
  x1: number; y1: number
  x2: number; y2: number
}

interface PowerPlacement {
  netName: string
  x: number
  y: number
  symbol: 'VCC' | 'GND' | string
  /** Pin coordinates of the component this power symbol connects to */
  componentPin: { x: number; y: number } | null
}

// ---------------------------------------------------------------------------
// lib_symbols database — fallback when resolver is unavailable
// ---------------------------------------------------------------------------

const EMBEDDED_LIB_SYMBOLS: Record<string, string> = {
  'Device:R': `
    (symbol "Device:R"
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "R" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (id 1) (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (id 2) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "~" (id 3) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "Device:R_0_1"
        (rectangle (start -1.016 2.54) (end 1.016 -2.54)
          (stroke (width 0.254) (type default)) (fill (type background))))
      (symbol "Device:R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))`,

  'Device:C': `
    (symbol "Device:C"
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "C" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "C" (id 1) (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (id 2) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "~" (id 3) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "Device:C_0_1"
        (polyline (pts (xy -2.032 0.508) (xy 2.032 0.508))
          (stroke (width 0.508) (type default)) (fill (type none)))
        (polyline (pts (xy -2.032 -0.508) (xy 2.032 -0.508))
          (stroke (width 0.508) (type default)) (fill (type none))))
      (symbol "Device:C_1_1"
        (pin passive line (at 0 3.81 270) (length 2.794)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 2.794)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))`,

  'Device:L': `
    (symbol "Device:L"
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "L" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "L" (id 1) (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (id 2) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "~" (id 3) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "Device:L_0_1"
        (arc (start 0 -2.54) (mid 1.27 0) (end 0 2.54)
          (stroke (width 0.254) (type default)) (fill (type none)))
        (arc (start 0 -1.27) (mid 2.54 0) (end 0 1.27)
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "Device:L_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))`,

  'Device:D': `
    (symbol "Device:D"
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "D" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "D" (id 1) (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (id 2) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "~" (id 3) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "Device:D_0_1"
        (polyline (pts (xy -1.27 1.27) (xy -1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
        (polyline (pts (xy -1.27 0) (xy 1.27 0)) (stroke (width 0) (type default)) (fill (type none)))
        (polyline (pts (xy 1.27 1.27) (xy 1.27 -1.27) (xy -1.27 0) (xy 1.27 1.27))
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "Device:D_1_1"
        (pin passive line (at -3.81 0 0) (length 2.54)
          (name "K" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 3.81 0 180) (length 2.54)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))`,

  'Device:LED': `
    (symbol "Device:LED"
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "D" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "LED" (id 1) (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (id 2) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "~" (id 3) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "Device:LED_0_1"
        (polyline (pts (xy -1.27 1.27) (xy -1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
        (polyline (pts (xy -1.27 0) (xy 1.27 0)) (stroke (width 0) (type default)) (fill (type none)))
        (polyline (pts (xy 1.27 1.27) (xy 1.27 -1.27) (xy -1.27 0) (xy 1.27 1.27))
          (stroke (width 0.254) (type default)) (fill (type none)))
        (polyline (pts (xy 1.524 2.286) (xy 2.54 3.302)) (stroke (width 0.2032) (type default)) (fill (type none)))
        (polyline (pts (xy 2.032 1.524) (xy 3.048 2.54)) (stroke (width 0.2032) (type default)) (fill (type none))))
      (symbol "Device:LED_1_1"
        (pin passive line (at -3.81 0 0) (length 2.54)
          (name "K" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 3.81 0 180) (length 2.54)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))`,

  'power:VCC': `
    (symbol "power:VCC"
      (power)
      (pin_names (offset 0))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "#PWR" (id 0) (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
      (property "Value" "VCC" (id 1) (at 0 3.556 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (id 2) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "" (id 3) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Description" "Power symbol creates a global label with name \\"VCC\\"" (id 4) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "VCC_0_1"
        (polyline (pts (xy -0.762 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none)))
        (polyline (pts (xy 0 2.54) (xy 0.762 1.27)) (stroke (width 0) (type default)) (fill (type none)))
        (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "VCC_1_1"
        (pin power_out line (at 0 0 90) (length 0)
          (name "VCC" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))`,

  'power:GND': `
    (symbol "power:GND"
      (power)
      (pin_names (offset 0))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "#PWR" (id 0) (at 0 -6.35 0) (effects (font (size 1.27 1.27))))
      (property "Value" "GND" (id 1) (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (id 2) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "" (id 3) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Description" "Power symbol creates a global label with name \\"GND\\"" (id 4) (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "GND_0_1"
        (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27))
          (stroke (width 0) (type default)) (fill (type none))))
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))`,
}

// ---------------------------------------------------------------------------
// Default pin offsets for symbols not in the database (2-pin symmetric)
// ---------------------------------------------------------------------------

interface PinOffset { dx: number; dy: number }

const DEFAULT_2PIN_OFFSETS: Record<string, { pin1: PinOffset; pin2: PinOffset }> = {
  'Device:R':  { pin1: { dx: 0, dy: -3.81 }, pin2: { dx: 0, dy: 3.81 } },
  'Device:C':  { pin1: { dx: 0, dy: -3.81 }, pin2: { dx: 0, dy: 3.81 } },
  'Device:L':  { pin1: { dx: 0, dy: -3.81 }, pin2: { dx: 0, dy: 3.81 } },
}

// ---------------------------------------------------------------------------
// UUID generation
// ---------------------------------------------------------------------------

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ---------------------------------------------------------------------------
// Pin coordinate computation — supports both resolved and fallback symbols
// ---------------------------------------------------------------------------

/**
 * Compute absolute pin coordinates for a component.
 *
 * Uses resolved pin definitions when available (from SymbolResolver),
 * otherwise falls back to hardcoded 2-pin offsets.
 *
 * Applies KiCad's Y-mirror: library Y-up → schematic Y-down.
 */
function computePinCoords(
  comp: SchematicComponent,
  x: number,
  y: number,
  _rotation: number,
  resolvedSymbol: ResolvedSymbol | null,
): Map<string, { x: number; y: number }> {
  const coords = new Map<string, { x: number; y: number }>()

  if (resolvedSymbol && resolvedSymbol.pins.size > 0) {
    // Use resolved pin definitions — iterate all pins
    for (const [pinNum, pin] of resolvedSymbol.pins) {
      // Pin position in library space is relative to symbol origin
      // Apply KiCad's Y-mirror: schematic Y = -library Y
      const pinX = x + pin.position.x
      const pinY = y - pin.position.y  // Y-mirror
      coords.set(pinNum, { x: pinX, y: pinY })
    }
  } else {
    // Fallback: hardcoded 2-pin offsets
    const libId = comp.symbol || comp.footprint
    const offsets = DEFAULT_2PIN_OFFSETS[libId] ?? { pin1: { dx: 0, dy: -3.81 }, pin2: { dx: 0, dy: 3.81 } }
    coords.set('1', { x: x + offsets.pin1.dx, y: y + offsets.pin1.dy })
    coords.set('2', { x: x + offsets.pin2.dx, y: y + offsets.pin2.dy })
  }

  return coords
}

// ---------------------------------------------------------------------------
// Symbol placement
// ---------------------------------------------------------------------------

function placeSymbols(
  schematic: ParsedSchematic,
  options: Required<SchLayoutOptions>,
  resolvedSymbols: Map<string, ResolvedSymbol>,
): PlacedSymbol[] {
  const placed: PlacedSymbol[] = []
  const spacingX = options.spacingX
  const spacingY = options.spacingY
  const cols = options.cols
  const startX = 50 // mm from left edge
  const startY = 40 // mm from top edge

  for (let i = 0; i < schematic.components.length; i++) {
    const comp = schematic.components[i]
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = Math.round((startX + col * spacingX) * 1000) / 1000
    const y = Math.round((startY + row * spacingY) * 1000) / 1000

    const rotation = 0
    const libId = comp.symbol || comp.footprint
    const resolved = resolvedSymbols.get(libId) ?? null
    const pinCoords = computePinCoords(comp, x, y, rotation, resolved)

    placed.push({ component: comp, x, y, rotation, pinCoords, resolvedSymbol: resolved })
  }

  return placed
}

// ---------------------------------------------------------------------------
// Wire routing
// ---------------------------------------------------------------------------

function routeWires(
  placed: PlacedSymbol[],
  nets: SchematicNet[],
): WireSegment[] {
  const wires: WireSegment[] = []
  const placedMap = new Map(placed.map((p) => [p.component.reference, p]))

  for (const net of nets) {
    // Find all pin positions for this net
    const pinPositions: { x: number; y: number; ref: string; pin: string }[] = []

    for (const ref of net.components) {
      const sym = placedMap.get(ref)
      if (!sym) continue

      // Find which pin connects to this net via the component's connections map
      const targetPin = sym.component.connections[net.name]
      if (targetPin && sym.pinCoords.has(targetPin)) {
        const coords = sym.pinCoords.get(targetPin)!
        pinPositions.push({ x: coords.x, y: coords.y, ref, pin: targetPin })
      } else if (!targetPin) {
        // No explicit connection — use pin 1 as default for first component only
        if (pinPositions.length === 0) {
          const coords = sym.pinCoords.get('1')
          if (coords) {
            pinPositions.push({ x: coords.x, y: coords.y, ref, pin: '1' })
          }
        }
      }
    }

    if (pinPositions.length < 2) continue

    // Route wires: connect all pins to the first pin (star from hub)
    const hub = pinPositions[0]
    for (let i = 1; i < pinPositions.length; i++) {
      const target = pinPositions[i]

      if (hub.x === target.x || hub.y === target.y) {
        // Straight line — single wire segment
        wires.push({ x1: hub.x, y1: hub.y, x2: target.x, y2: target.y })
      } else {
        // L-shaped route: go horizontal first, then vertical
        wires.push({ x1: hub.x, y1: hub.y, x2: target.x, y2: hub.y })
        wires.push({ x1: target.x, y1: hub.y, x2: target.x, y2: target.y })
      }
    }
  }

  return wires
}

// ---------------------------------------------------------------------------
// Power symbol placement
// ---------------------------------------------------------------------------

function placePowerSymbols(
  schematic: ParsedSchematic,
  placed: PlacedSymbol[],
  _options: Required<SchLayoutOptions>,
): { symbols: PowerPlacement[]; libSymbols: string[] } {
  const powerSymbols: PowerPlacement[] = []
  const neededLibSymbols = new Set<string>()

  // Identify power nets (VCC, GND, +3V3, +5V, etc.)
  const powerNets = schematic.nets.filter((n) =>
    /^(vcc|gnd|vdd|vss|\+[0-9]+v?[0-9]*|-[0-9]+v?[0-9]*|power)$/i.test(n.name)
  )

  const placedMap = new Map(placed.map((p) => [p.component.reference, p]))

  for (const net of powerNets) {
    const isPositive = !/^(gnd|vss|-)/i.test(net.name)
    const symbolName = isPositive ? `power:${net.name.toUpperCase()}` : 'power:GND'

    // Check if we have this power symbol in our database
    if (!EMBEDDED_LIB_SYMBOLS[symbolName] && !EMBEDDED_LIB_SYMBOLS['power:VCC']) continue

    // Place power symbol near the first component connected to this net
    const firstRef = net.components[0]
    const sym = placedMap.get(firstRef)

    if (sym) {
      // Find the pin that connects to this power net
      const targetPin = sym.component.connections[net.name]
      const pinCoords = targetPin ? sym.pinCoords.get(targetPin) : sym.pinCoords.get('1')

      const px = pinCoords ? pinCoords.x : sym.x
      const py = pinCoords ? pinCoords.y : sym.y

      // Power symbol pin is at (0,0) of the symbol, so place it at the component pin location.
      // Then offset it: VCC above (y - 5mm), GND below (y + 5mm).
      const actualSymbol = EMBEDDED_LIB_SYMBOLS[symbolName] ? symbolName : 'power:VCC'
      const yOffset = isPositive ? -5 : 5
      powerSymbols.push({
        netName: net.name,
        x: px,
        y: py + yOffset,
        symbol: actualSymbol,
        componentPin: pinCoords ? { x: px, y: py } : null,
      })
      neededLibSymbols.add(actualSymbol)
    }
  }

  // Always include VCC and GND if any power nets exist
  if (powerSymbols.some((p) => p.symbol === 'power:VCC') || powerNets.some((n) => /^\+|vcc|vdd/i.test(n.name))) {
    neededLibSymbols.add('power:VCC')
  }
  if (powerSymbols.some((p) => p.symbol === 'power:GND') || powerNets.some((n) => /^-|gnd|vss/i.test(n.name))) {
    neededLibSymbols.add('power:GND')
  }

  return { symbols: powerSymbols, libSymbols: [...neededLibSymbols] }
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate .kicad_sch content from parsed schematic data.
 *
 * Creates a complete KiCad schematic file with embedded library symbols,
 * placed components, power symbols, and wires.
 *
 * When a SymbolResolver is provided, symbols are resolved from KiCad libraries
 * with accurate pin definitions. Without a resolver, falls back to embedded
 * 2-pin symbols for Device:R/C/L and power symbols.
 */
export async function generateSchContent(
  schematic: ParsedSchematic,
  options: SchLayoutOptions = {},
): Promise<string> {
  const opts: Required<SchLayoutOptions> = {
    paper: options.paper ?? 'A4',
    spacingX: options.spacingX ?? 25.4,
    spacingY: options.spacingY ?? 25.4,
    cols: options.cols ?? 6,
    projectName: options.projectName ?? 'vajra',
    resolver: options.resolver ?? null!,
  }

  const rootUuid = uuid()
  const lines: string[] = []

  // 1. Resolve symbols via resolver (if available)
  const resolvedSymbols = new Map<string, ResolvedSymbol>()
  const resolver = options.resolver

  if (resolver) {
    for (const comp of schematic.components) {
      const libId = comp.symbol || comp.footprint
      if (!resolvedSymbols.has(libId)) {
        try {
          const resolved = await resolver.resolve(libId)
          resolvedSymbols.set(libId, resolved)
        } catch {
          // Resolver failed — will use embedded fallback
        }
      }
    }
  }

  // 2. Place symbols
  const placed = placeSymbols(schematic, opts, resolvedSymbols)

  // 3. Place power symbols
  const { symbols: powerSymbols, libSymbols: neededPowerLibs } = placePowerSymbols(schematic, placed, opts)

  // 4. Route wires
  const wires = routeWires(placed, schematic.nets)

  // 5. Determine which lib_symbols we need
  const neededLibSymbols = new Set<string>(neededPowerLibs)
  for (const comp of schematic.components) {
    const sym = comp.symbol || comp.footprint
    // Try to find a matching lib symbol
    if (EMBEDDED_LIB_SYMBOLS[sym] || resolvedSymbols.has(sym)) {
      neededLibSymbols.add(sym)
    } else {
      // Use Device:R as fallback for unknown passives
      const lower = sym.toLowerCase()
      if (lower.includes('cap')) neededLibSymbols.add('Device:C')
      else if (lower.includes('ind') || lower.includes('coil')) neededLibSymbols.add('Device:L')
      else neededLibSymbols.add('Device:R')
    }
  }

  // === Build the S-expression ===

  // Header
  lines.push('(kicad_sch')
  lines.push('  (version 20231231)')
  lines.push('  (generator "vajra-kicad")')
  lines.push('  (generator_version "8.0")')
  lines.push(`  (uuid "${rootUuid}")`)
  lines.push(`  (paper "${opts.paper}")`)
  lines.push('')

  // lib_symbols — use resolved definitions when available, embedded as fallback
  lines.push('  (lib_symbols')
  for (const libSymName of neededLibSymbols) {
    // Priority 1: resolved from library (has rawDefinition)
    const resolved = resolvedSymbols.get(libSymName)
    if (resolved?.rawDefinition) {
      const defLines = resolved.rawDefinition.split('\n').filter((l) => l.trim())
      for (const dl of defLines) {
        lines.push(`    ${dl.trim()}`)
      }
      continue
    }

    // Priority 2: embedded fallback
    const definition = EMBEDDED_LIB_SYMBOLS[libSymName]
    if (definition) {
      const defLines = definition.split('\n').filter((l) => l.trim())
      for (const dl of defLines) {
        lines.push(`    ${dl.trim()}`)
      }
    }
  }
  lines.push('  )')
  lines.push('')

  // Placed component symbols
  for (const placedSym of placed) {
    const comp = placedSym.component
    const symUuid = uuid()

    // Determine lib_id
    const libId = neededLibSymbols.has(comp.symbol) ? comp.symbol :
      comp.symbol.toLowerCase().includes('cap') ? 'Device:C' :
      comp.symbol.toLowerCase().includes('ind') ? 'Device:L' :
      'Device:R'

    lines.push(`  (symbol`)
    lines.push(`    (lib_id "${libId}")`)
    lines.push(`    (at ${placedSym.x} ${placedSym.y} ${placedSym.rotation})`)
    lines.push('    (unit 1)')
    lines.push('    (body_style 1)')
    lines.push('    (exclude_from_sim no)')
    lines.push('    (in_bom yes)')
    lines.push('    (on_board yes)')
    lines.push('    (in_pos_files yes)')
    lines.push('    (dnp no)')
    lines.push('    (fields_autoplaced yes)')
    lines.push(`    (uuid "${symUuid}")`)

    // Properties
    lines.push(`    (property "Reference" "${comp.reference}" (at ${placedSym.x + 3.175} ${placedSym.y - 1.27} 0) (effects (font (size 1.27 1.27))))`)
    lines.push(`    (property "Value" "${comp.value}" (at ${placedSym.x + 3.175} ${placedSym.y + 1.27} 0) (effects (font (size 1.27 1.27))))`)
    lines.push(`    (property "Footprint" "${comp.footprint}" (at ${placedSym.x} ${placedSym.y} 0) (hide yes) (effects (font (size 1.27 1.27))))`)
    lines.push(`    (property "Datasheet" "" (at ${placedSym.x} ${placedSym.y} 0) (hide yes) (effects (font (size 1.27 1.27))))`)

    // Pin UUIDs — generate one for each pin in the placed symbol
    if (placedSym.resolvedSymbol) {
      for (const pinNum of placedSym.resolvedSymbol.pins.keys()) {
        lines.push(`    (pin "${pinNum}" (uuid "${uuid()}"))`)
      }
    } else {
      // Fallback: 2 pins
      lines.push(`    (pin "1" (uuid "${uuid()}"))`)
      lines.push(`    (pin "2" (uuid "${uuid()}"))`)
    }

    // Instance tracking
    lines.push('    (instances')
    lines.push(`      (project "${opts.projectName}"`)
    lines.push(`        (path "/${rootUuid}"`)
    lines.push(`          (reference "${comp.reference}")`)
    lines.push('          (unit 1)')
    lines.push('        )')
    lines.push('      )')
    lines.push('    )')
    lines.push('  )')
    lines.push('')
  }

  // Power symbols
  let pwrCount = 0
  for (const pwr of powerSymbols) {
    pwrCount++
    const pwrUuid = uuid()
    const pinUuid = uuid()
    const actualLibId = pwr.symbol

    lines.push(`  (symbol`)
    lines.push(`    (lib_id "${actualLibId}")`)
    lines.push(`    (at ${pwr.x} ${pwr.y} 0)`)
    lines.push('    (unit 1)')
    lines.push('    (body_style 1)')
    lines.push('    (exclude_from_sim no)')
    lines.push('    (in_bom yes)')
    lines.push('    (on_board yes)')
    lines.push('    (in_pos_files yes)')
    lines.push('    (dnp no)')
    lines.push('    (fields_autoplaced yes)')
    lines.push(`    (uuid "${pwrUuid}")`)

    // Power symbol properties
    const pwrRef = `#PWR${String(pwrCount).padStart(2, '0')}`
    lines.push(`    (property "Reference" "${pwrRef}" (at ${pwr.x} ${pwr.y - 3.81} 0) (hide yes) (effects (font (size 1.27 1.27))))`)
    lines.push(`    (property "Value" "${pwr.netName}" (at ${pwr.x} ${pwr.y + 3.556} 0) (effects (font (size 1.27 1.27))))`)
    lines.push(`    (property "Footprint" "" (at ${pwr.x} ${pwr.y} 0) (hide yes) (effects (font (size 1.27 1.27))))`)
    lines.push(`    (property "Datasheet" "" (at ${pwr.x} ${pwr.y} 0) (hide yes) (effects (font (size 1.27 1.27))))`)
    lines.push(`    (property "Description" "Power symbol creates a global label with name \\"${pwr.netName}\\"" (at ${pwr.x} ${pwr.y} 0) (hide yes) (effects (font (size 1.27 1.27))))`)

    lines.push(`    (pin "1" (uuid "${pinUuid}"))`)

    lines.push('    (instances')
    lines.push(`      (project "${opts.projectName}"`)
    lines.push(`        (path "/${rootUuid}"`)
    lines.push(`          (reference "${pwrRef}")`)
    lines.push('          (unit 1)')
    lines.push('        )')
    lines.push('      )')
    lines.push('    )')
    lines.push('  )')
    lines.push('')
  }

  // Wires — net connections
  for (const wire of wires) {
    const wireUuid = uuid()
    lines.push('  (wire')
    lines.push('    (pts')
    lines.push(`      (xy ${wire.x1} ${wire.y1})`)
    lines.push(`      (xy ${wire.x2} ${wire.y2})`)
    lines.push('    )')
    lines.push('    (stroke (width 0) (type default))')
    lines.push(`    (uuid "${wireUuid}")`)
    lines.push('  )')
  }

  // Wires — power symbols to component pins
  for (const pwr of powerSymbols) {
    if (pwr.componentPin) {
      const wireUuid = uuid()
      lines.push('  (wire')
      lines.push('    (pts')
      lines.push(`      (xy ${pwr.x} ${pwr.y})`)
      lines.push(`      (xy ${pwr.componentPin.x} ${pwr.componentPin.y})`)
      lines.push('    )')
      lines.push('    (stroke (width 0) (type default))')
      lines.push(`    (uuid "${wireUuid}")`)
      lines.push('  )')
    }
  }

  if (wires.length > 0 || powerSymbols.length > 0) lines.push('')

  // Net labels for each net
  for (const net of schematic.nets) {
    const labelUuid = uuid()
    // Place label near the first component's pin
    const firstRef = net.components[0]
    const sym = placed.find((p) => p.component.reference === firstRef)
    if (sym) {
      const pinCoords = sym.pinCoords.get('1')
      const lx = pinCoords ? pinCoords.x + 2 : sym.x + 5
      const ly = pinCoords ? pinCoords.y : sym.y

      lines.push(`  (label "${net.name}"`)
      lines.push(`    (at ${lx} ${ly} 0)`)
      lines.push('    (effects (font (size 1.27 1.27)) (justify left))')
      lines.push(`    (uuid "${labelUuid}")`)
      lines.push('  )')
    }
  }

  if (schematic.nets.length > 0) lines.push('')

  // Sheet instances (required)
  lines.push('  (sheet_instances')
  lines.push(`    (path "/" (page "1"))`)
  lines.push('  )')
  lines.push('')

  lines.push(')')
  return lines.join('\n')
}

/**
 * Generate a .kicad_sch file from schematic data.
 */
export async function generateSch(
  schematic: ParsedSchematic,
  outputPath: string,
  options: SchLayoutOptions = {},
): Promise<void> {
  const content = await generateSchContent(schematic, options)
  await writeFile(outputPath, content, 'utf-8')
}
