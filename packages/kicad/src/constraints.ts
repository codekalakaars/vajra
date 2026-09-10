// Board constraint types for PCB generation.
//
// These define the physical and electrical parameters the agent uses
// when generating a PCB from a schematic.

/** Copper layer count (capped at 4 due to KiCad layer ID conflicts at 6) */
export type LayerCount = 1 | 2 | 4

/** Board outline point (mm) */
export interface Point {
  x: number
  y: number
}

/** Mounting hole specification */
export interface MountingHole {
  x: number
  y: number
  /** Hole diameter in mm */
  diameter: number
  /** Pad diameter in mm (defaults to diameter * 2) */
  padDiameter?: number
}

/** Design rules for trace routing */
export interface DesignRules {
  /** Minimum trace width in mm (default: 0.25) */
  minTraceWidth: number
  /** Minimum clearance between traces in mm (default: 0.25) */
  minClearance: number
  /** Minimum via drill diameter in mm (default: 0.3) */
  minViaDrill: number
  /** Minimum via pad diameter in mm (default: 0.6) */
  minViaSize: number
  /** Minimum annular ring in mm (default: 0.15) */
  minAnnularRing: number
}

/** Board constraints for PCB generation */
export interface BoardConstraints {
  /** Board width in mm */
  width: number
  /** Board height in mm */
  height: number
  /** Number of copper layers */
  layers: LayerCount
  /** Custom board outline (overrides width/height if provided) */
  outline?: Point[]
  /** Mounting holes */
  mountingHoles?: MountingHole[]
  /** Design rules (defaults applied if not specified) */
  designRules?: Partial<DesignRules>
  /** Whether to add ground plane on inner/bottom layers (default: true) */
  groundPlane?: boolean
  /** Board stackup description */
  stackup?: string
}

export const DEFAULT_DESIGN_RULES: DesignRules = {
  minTraceWidth: 0.25,
  minClearance: 0.25,
  minViaDrill: 0.3,
  minViaSize: 0.6,
  minAnnularRing: 0.15,
}

export function resolveDesignRules(partial?: Partial<DesignRules>): DesignRules {
  const rules = { ...DEFAULT_DESIGN_RULES, ...partial }
  // Validate non-negative values
  if (rules.minTraceWidth < 0) throw new Error(`minTraceWidth must be >= 0, got ${rules.minTraceWidth}`)
  if (rules.minClearance < 0) throw new Error(`minClearance must be >= 0, got ${rules.minClearance}`)
  if (rules.minViaDrill < 0) throw new Error(`minViaDrill must be >= 0, got ${rules.minViaDrill}`)
  if (rules.minViaSize < 0) throw new Error(`minViaSize must be >= 0, got ${rules.minViaSize}`)
  if (rules.minAnnularRing < 0) throw new Error(`minAnnularRing must be >= 0, got ${rules.minAnnularRing}`)
  return rules
}
