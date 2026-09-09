// Generate a .kicad_pcb file from a parsed schematic and board constraints.
//
// Creates a complete PCB file with:
// - Board outline from constraints
// - Placed footprints
// - Net definitions
// - Layer stackup
// - Design rules
//
// The generated file can be opened directly in KiCad's PCB editor for
// manual routing, or used as a starting point for auto-routing.

import { writeFile } from 'node:fs/promises'
import type { ParsedSchematic } from './schematic.js'
import type { BoardConstraints, DesignRules } from './constraints.js'
import { resolveDesignRules } from './constraints.js'
import type { PlacedFootprint } from './placement.js'
import type { UnroutedConnection } from './routing.js'

/** Generate the full .kicad_pcb content */
export function generatePcbContent(
  schematic: ParsedSchematic,
  placed: PlacedFootprint[],
  connections: UnroutedConnection[],
  constraints: BoardConstraints,
  designRules: DesignRules,
): string {
  const lines: string[] = []

  // Header
  lines.push('(kicad_pcb')
  lines.push('  (version 20240101)')
  lines.push('  (generator "vajra-kicad")')
  lines.push('')

  // General
  lines.push('  (general')
  lines.push(`    (thickness 1.6)`)
  lines.push('  )')
  lines.push('')

  // Paper size (matches board dimensions)
  lines.push(`  (paper "A4")`)
  lines.push('')

  // KiCad layer IDs: F.Cu=0, B.Cu=31, In1.Cu=32, In2.Cu=33
  // User layers: B.Adhes=34, F.Adhes=35, B.Paste=36, F.Paste=37, etc.
  // Note: In3.Cu(34) and In4.Cu(35) conflict with B.Adhes/F.Adhes,
  // so we cap at 4 copper layers for generated PCBs.
  lines.push('  (layers')
  lines.push('    (0 "F.Cu" signal)')
  if (constraints.layers >= 2) lines.push('    (31 "B.Cu" signal)')
  if (constraints.layers >= 4) {
    lines.push('    (32 "In1.Cu" signal)')
    lines.push('    (33 "In2.Cu" signal)')
  }
  lines.push('    (34 "B.Adhes" user "B.Adhesive")')
  lines.push('    (35 "F.Adhes" user "F.Adhesive")')
  lines.push('    (36 "B.Paste" user)')
  lines.push('    (37 "F.Paste" user)')
  lines.push('    (38 "B.SilkS" user "B.Silkscreen")')
  lines.push('    (39 "F.SilkS" user "F.Silkscreen")')
  lines.push('    (40 "B.Mask" user "B.Mask")')
  lines.push('    (41 "F.Mask" user "F.Mask")')
  lines.push('    (42 "Dwgs.User" user "User.Drawings")')
  lines.push('    (43 "Cmts.User" user "User.Comments")')
  lines.push('    (44 "Eco1.User" user "User.Eco1")')
  lines.push('    (45 "Eco2.User" user "User.Eco2")')
  lines.push('    (46 "Edge.Cuts" user)')
  lines.push('    (47 "Margin" user)')
  lines.push('    (48 "B.CrtYd" user "B.Courtyard")')
  lines.push('    (49 "F.CrtYd" user "F.Courtyard")')
  lines.push('    (50 "B.Fab" user)')
  lines.push('    (51 "F.Fab" user)')
  lines.push('  )')
  lines.push('')

  // Setup
  lines.push('  (setup')
  lines.push('    (pad_to_mask_clearance 0)')
  lines.push('    (aux_axis_origin 0 0)')
  lines.push('    (pcbplotparams')
  lines.push('      (layerselection 0x00010fc_ffffffff)')
  lines.push('      (plot_on_all_layers_selection 0x0000000_00000000)')
  lines.push('      (disableapertmacros false)')
  lines.push('      (usegerberextensions false)')
  lines.push('      (usegerberattributes true)')
  lines.push('      (usegerberadvancedattributes true)')
  lines.push('      (creategerberjobfile true)')
  lines.push('      (dashed_line_dash_ratio 12.000000)')
  lines.push('      (dashed_line_gap_ratio 3.000000)')
  lines.push('      (svgprecision 4)')
  lines.push('      (plotframeref false)')
  lines.push('      (viasonmask false)')
  lines.push('      (mode 1)')
  lines.push('      (useauxorigin false)')
  lines.push('      (hpglpennumber 1)')
  lines.push('      (hpglpenspeed 20)')
  lines.push('      (hpglpendiameter 15.000000)')
  lines.push('      (dxfpolygonmode true)')
  lines.push('      (dxfimperialunits true)')
  lines.push('      (dxfusepcbnewfont true)')
  lines.push('      (psnegative false)')
  lines.push('      (psa4output false)')
  lines.push('      (plotreference true)')
  lines.push('      (plotvalue true)')
  lines.push('      (plotfptext true)')
  lines.push('      (plotinvisibletext false)')
  lines.push('      (sketchpadsonfab false)')
  lines.push('      (subtractmaskfromsilk false)')
  lines.push('      (outputformat 1)')
  lines.push('      (mirror false)')
  lines.push('      (drillshape 1)')
  lines.push('      (scaleselection 1)')
  lines.push('      (outputdirectory "")')
  lines.push('    )')
  lines.push('  )')
  lines.push('')

  // Nets
  lines.push('  (net 0 "")')
  for (const net of schematic.nets) {
    lines.push(`  (net ${net.code} "${net.name}")`)
  }
  lines.push('')

  // Board outline (Edge.Cuts)
  lines.push('  (gr_line (start 0 0) (end ' + constraints.width + ' 0) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))')
  lines.push('  (gr_line (start ' + constraints.width + ' 0) (end ' + constraints.width + ' ' + constraints.height + ') (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))')
  lines.push('  (gr_line (start ' + constraints.width + ' ' + constraints.height + ') (end 0 ' + constraints.height + ') (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))')
  lines.push('  (gr_line (start 0 ' + constraints.height + ') (end 0 0) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))')
  lines.push('')

  // Mounting holes
  if (constraints.mountingHoles) {
    for (const mh of constraints.mountingHoles) {
      const padDiameter = mh.padDiameter ?? mh.diameter * 2
      lines.push(`  (footprint "MountingHole:MountingHole_3.2mm_PadPad"`)
      lines.push(`    (layer "F.Cu")`)
      lines.push(`    (at ${mh.x} ${mh.y})`)
      lines.push(`    (property "Reference" "MH${constraints.mountingHoles.indexOf(mh) + 1}" (at 0 -3.5) (layer "F.SilkS") (uuid "${generateUuid()}"))`)
      lines.push(`    (pad "1" thru_hole circle (at 0 0) (size ${padDiameter} ${padDiameter}) (drill ${mh.diameter}) (layers "*.Cu" "*.Mask") (net 0 "") (uuid "${generateUuid()}"))`)
      lines.push(`  )`)
    }
    lines.push('')
  }

  // Placed footprints
  for (const fp of placed) {
    lines.push(`  (footprint "${fp.footprint}"`)
    lines.push(`    (layer "${fp.layer}")`)
    lines.push(`    (at ${fp.x} ${fp.y}${fp.rotation ? ` ${fp.rotation}` : ''})`)
    lines.push(`    (property "Reference" "${fp.reference}" (at 0 -2) (layer "F.SilkS") (uuid "${generateUuid()}"))`)
    lines.push(`    (property "Value" "${fp.value}" (at 0 2) (layer "F.Fab") (uuid "${generateUuid()}"))`)

    // Find the net for this component
    const compNet = schematic.nets.find((n) => n.components.includes(fp.reference))
    const netCode = compNet ? compNet.code : 0
    const netName = compNet ? compNet.name : ''

    // Add a placeholder pad (actual pad geometry comes from the footprint library)
    lines.push(`    (pad "1" smd rect (at 0 0) (size 1.5 1) (layers "F.Cu" "F.Paste" "F.Mask") (net ${netCode} "${netName}") (uuid "${generateUuid()}"))`)
    lines.push(`  )`)
  }
  lines.push('')

  // Design rules
  lines.push('  (net_class "Default" ""')
  lines.push(`    (clearance ${designRules.minClearance})`)
  lines.push(`    (trace_width ${designRules.minTraceWidth})`)
  lines.push(`    (via_dia ${designRules.minViaSize})`)
  lines.push(`    (via_drill ${designRules.minViaDrill})`)
  lines.push(`    (uvia_dia ${designRules.minViaSize})`)
  lines.push(`    (uvia_drill ${designRules.minViaDrill})`)
  for (const net of schematic.nets) {
    lines.push(`    (add_net "${net.name}")`)
  }
  lines.push('  )')
  lines.push('')

  lines.push(')')
  return lines.join('\n')
}

function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/**
 * Generate a .kicad_pcb file from schematic data and constraints.
 */
export async function generatePcb(
  schematic: ParsedSchematic,
  placed: PlacedFootprint[],
  connections: UnroutedConnection[],
  constraints: BoardConstraints,
  outputPath: string,
): Promise<void> {
  const designRules = resolveDesignRules(constraints.designRules)
  const content = generatePcbContent(schematic, placed, connections, constraints, designRules)
  await writeFile(outputPath, content, 'utf-8')
}
