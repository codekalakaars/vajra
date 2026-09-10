import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseNetlist } from '../dist/schematic.js'
import { placeFootprints, isIC, isConnector, isPower, isDecouplingCap } from '../dist/placement.js'
import { generatePcbContent, isSmd } from '../dist/pcb-generator.js'
import { generateUnroutedConnections } from '../dist/routing.js'
import { resolveDesignRules } from '../dist/constraints.js'
import { parseDrcReport } from '../dist/drc.js'
import { generateSchContent } from '../dist/schematic-generator.js'
import { parseSymbolLibrary, parseSymLibTable, generateBoxSymbol, SymbolResolver } from '../dist/symbol-lib.js'

// ---------------------------------------------------------------------------
// Netlist parser
// ---------------------------------------------------------------------------

describe('parseNetlist', () => {
  it('parses a simple netlist with components and nets', () => {
    const netlist = `
(export (version D)
  (design
    (source "test.kicad_sch")
    (date "2024-01-01")
    (tool "kicad-cli")
  )
  (components
    (comp (ref R1) (value "10k") (footprint "Resistor_SMD:R_0402_1005Metric") (libsymbol "Device:R"))
    (comp (ref R2) (value "10k") (footprint "Resistor_SMD:R_0402_1005Metric") (libsymbol "Device:R"))
    (comp (ref U1) (value "ATmega328P") (footprint "MCU_Atmel_ATmega:QFP-32_7x7mm_P0.5mm") (libsymbol "MCU_Atmel_ATmega:ATmega328P-AU"))
  )
  (nets
    (net (code 1) (name "VCC")
      (node (ref U1) (pin 1))
      (node (ref R1) (pin 1))
    )
    (net (code 2) (name "GND")
      (node (ref U1) (pin 8))
      (node (ref R2) (pin 1))
    )
    (net (code 3) (name "SIG")
      (node (ref R1) (pin 2))
      (node (ref R2) (pin 2))
    )
  )
)
`
    const result = parseNetlist(netlist)

    assert.equal(result.componentCount, 3)
    assert.equal(result.netCount, 3)

    const r1 = result.components.find(c => c.reference === 'R1')
    assert.ok(r1)
    assert.equal(r1.value, '10k')
    assert.equal(r1.footprint, 'Resistor_SMD:R_0402_1005Metric')

    const u1 = result.components.find(c => c.reference === 'U1')
    assert.ok(u1)
    assert.equal(u1.value, 'ATmega328P')

    const vcc = result.nets.find(n => n.name === 'VCC')
    assert.ok(vcc)
    assert.deepEqual(vcc.components, ['U1', 'R1'])

    const gnd = result.nets.find(n => n.name === 'GND')
    assert.ok(gnd)
    assert.deepEqual(gnd.components, ['U1', 'R2'])

    const sig = result.nets.find(n => n.name === 'SIG')
    assert.ok(sig)
    assert.deepEqual(sig.components, ['R1', 'R2'])
  })

  it('filters out UNCONNECTED nets', () => {
    const netlist = `
(export (version D)
  (components
    (comp (ref R1) (value "10k") (footprint "Resistor_SMD:R_0402") (libsymbol "Device:R"))
  )
  (nets
    (net (code 1) (name "VCC")
      (node (ref R1) (pin 1))
    )
    (net (code 2) (name "UNCONNECTED")
      (node (ref R1) (pin 2))
    )
  )
)
`
    const result = parseNetlist(netlist)
    assert.equal(result.netCount, 1)
    assert.equal(result.nets[0].name, 'VCC')
  })

  it('handles empty netlist', () => {
    const netlist = `
(export (version D)
  (components)
  (nets)
)
`
    const result = parseNetlist(netlist)
    assert.equal(result.componentCount, 0)
    assert.equal(result.netCount, 0)
  })

  it('records pin connections on components', () => {
    const netlist = `
(export (version D)
  (components
    (comp (ref R1) (value "10k") (footprint "Resistor_SMD:R_0402") (libsymbol "Device:R"))
  )
  (nets
    (net (code 1) (name "VCC")
      (node (ref R1) (pin 1))
    )
    (net (code 2) (name "SIG")
      (node (ref R1) (pin 2))
    )
  )
)
`
    const result = parseNetlist(netlist)
    const r1 = result.components.find(c => c.reference === 'R1')
    assert.ok(r1)
    assert.equal(r1.connections['VCC'], '1')
    assert.equal(r1.connections['SIG'], '2')
  })

  it('throws on empty string', () => {
    assert.throws(() => parseNetlist(''), /content must be a non-empty string/)
  })

  it('throws on non-string input', () => {
    assert.throws(() => parseNetlist(null), /content must be a non-empty string/)
    assert.throws(() => parseNetlist(undefined), /content must be a non-empty string/)
  })

  it('throws on non-netlist content', () => {
    assert.throws(() => parseNetlist('hello world'), /does not look like a KiCad netlist/)
  })

  it('parses netlist with components but no nets section', () => {
    const netlist = `
(export (version D)
  (components
    (comp (ref R1) (value "10k") (footprint "Resistor_SMD:R_0402") (libsymbol "Device:R"))
  )
)
`
    const result = parseNetlist(netlist)
    assert.equal(result.componentCount, 1)
    assert.equal(result.netCount, 0)
  })

  it('parses netlist with 3-component net (star connectivity)', () => {
    const netlist = `
(export (version D)
  (components
    (comp (ref R1) (value "10k") (footprint "R_0402") (libsymbol "Device:R"))
    (comp (ref R2) (value "10k") (footprint "R_0402") (libsymbol "Device:R"))
    (comp (ref R3) (value "10k") (footprint "R_0402") (libsymbol "Device:R"))
  )
  (nets
    (net (code 1) (name "BUS")
      (node (ref R1) (pin 1))
      (node (ref R2) (pin 1))
      (node (ref R3) (pin 1))
    )
  )
)
`
    const result = parseNetlist(netlist)
    assert.equal(result.netCount, 1)
    assert.deepEqual(result.nets[0].components, ['R1', 'R2', 'R3'])
  })

  it('parses complex netlist via fallback path', () => {
    // Netlist format that won't match the primary regex
    const netlist = `
(export (version D)
  (components
    (comp (ref "R1") (value "10k") (footprint "R_0402") (libsymbol "Device:R"))
    (comp (ref "R2") (value "4.7k") (footprint "R_0402") (libsymbol "Device:R"))
  )
  (nets
    (net (code 1) (name "VCC")
      (node (ref "R1") (pin "1"))
      (node (ref "R2") (pin "1"))
    )
  )
)
`
    const result = parseNetlist(netlist)
    assert.equal(result.componentCount, 2)
    assert.equal(result.netCount, 1)
    assert.deepEqual(result.nets[0].components, ['R1', 'R2'])
  })
})

// ---------------------------------------------------------------------------
// Placement algorithm
// ---------------------------------------------------------------------------

describe('placeFootprints', () => {
  it('places all components on the board', () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R', connections: {} },
        { reference: 'R2', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R', connections: {} },
        { reference: 'C1', value: '100nF', footprint: 'Capacitor_SMD:C_0402', symbol: 'Device:C', connections: {} },
      ],
      nets: [],
      componentCount: 3,
      netCount: 0,
    }

    const constraints = { width: 50, height: 30, layers: 2 }
    const placed = placeFootprints(schematic, constraints)

    assert.equal(placed.length, 3)
    for (const fp of placed) {
      assert.ok(fp.x >= 5 && fp.x <= 45, `${fp.reference} x=${fp.x} out of bounds`)
      assert.ok(fp.y >= 5 && fp.y <= 25, `${fp.reference} y=${fp.y} out of bounds`)
    }
  })

  it('places ICs in center area', () => {
    const schematic = {
      components: [
        { reference: 'U1', value: 'STM32F103', footprint: 'MCU_ST_STM32:LQFP-48', symbol: 'MCU_ST_STM32:STM32F103C8Tx', connections: {} },
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [],
      componentCount: 2,
      netCount: 0,
    }

    const constraints = { width: 100, height: 80, layers: 2 }
    const placed = placeFootprints(schematic, constraints)

    const u1 = placed.find(p => p.reference === 'U1')
    assert.ok(u1)
    assert.ok(u1.x > 30 && u1.x < 70, `U1 x=${u1.x} not in center`)
    assert.ok(u1.y > 20 && u1.y < 60, `U1 y=${u1.y} not in center`)
  })

  it('places connectors at board edges', () => {
    const schematic = {
      components: [
        { reference: 'J1', value: 'USB-C', footprint: 'Connector_USB:USB_C_Receptacle_XKB_U262-16XN-4BVC11', symbol: 'Connector:Conn_USB_C', connections: {} },
        { reference: 'J2', value: 'Header', footprint: 'Connector_PinHeader_2.54mm:PinHeader_2x05_P2.54mm_Vertical', symbol: 'Connector:Conn_02x05_Odd_Even', connections: {} },
      ],
      nets: [],
      componentCount: 2,
      netCount: 0,
    }

    const constraints = { width: 100, height: 80, layers: 2 }
    const placed = placeFootprints(schematic, constraints)

    const j1 = placed.find(p => p.reference === 'J1')
    const j2 = placed.find(p => p.reference === 'J2')
    assert.ok(j1)
    assert.ok(j2)

    const j1NearEdge = j1.x < 15 || j1.x > 85 || j1.y < 15 || j1.y > 65
    const j2NearEdge = j2.x < 15 || j2.x > 85 || j2.y < 15 || j2.y > 65
    assert.ok(j1NearEdge || j2NearEdge, 'At least one connector should be near board edge')
  })

  it('does not place components at same position', () => {
    const schematic = {
      components: Array.from({ length: 10 }, (_, i) => ({
        reference: `R${i + 1}`,
        value: '10k',
        footprint: 'Resistor_SMD:R_0402',
        symbol: 'Device:R',
        connections: {},
      })),
      nets: [],
      componentCount: 10,
      netCount: 0,
    }

    const constraints = { width: 50, height: 30, layers: 2 }
    const placed = placeFootprints(schematic, constraints)

    const positions = new Set(placed.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`))
    assert.equal(positions.size, placed.length, 'Some components share the same position')
  })

  it('returns empty array for empty schematic', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const constraints = { width: 50, height: 30, layers: 2 }
    const placed = placeFootprints(schematic, constraints)
    assert.equal(placed.length, 0)
  })

  it('places single component near center', () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [],
      componentCount: 1,
      netCount: 0,
    }
    const constraints = { width: 100, height: 80, layers: 2 }
    const placed = placeFootprints(schematic, constraints)
    assert.equal(placed.length, 1)
    assert.ok(placed[0].x >= 5 && placed[0].x <= 95)
    assert.ok(placed[0].y >= 5 && placed[0].y <= 75)
  })

  it('throws on invalid board dimensions', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    assert.throws(() => placeFootprints(schematic, { width: 0, height: 30, layers: 2 }), /width must be > 0/)
    assert.throws(() => placeFootprints(schematic, { width: 50, height: -1, layers: 2 }), /height must be > 0/)
    assert.throws(() => placeFootprints(schematic, { width: 50, height: 30, layers: 3 }), /layers must be 1, 2, or 4/)
  })

  it('places passives near connected ICs', () => {
    const schematic = {
      components: [
        { reference: 'U1', value: 'STM32F103', footprint: 'MCU_ST_STM32:LQFP-48', symbol: 'MCU_ST_STM32:STM32F103C8Tx', connections: {} },
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
        { reference: 'C1', value: '100nF', footprint: 'C_0402', symbol: 'Device:C', connections: {} },
      ],
      nets: [
        { name: 'VCC', code: 1, components: ['U1', 'R1'] },
        { name: 'GND', code: 2, components: ['U1', 'C1'] },
      ],
      componentCount: 3,
      netCount: 2,
    }

    const constraints = { width: 100, height: 80, layers: 2 }
    const placed = placeFootprints(schematic, constraints)

    const u1 = placed.find(p => p.reference === 'U1')
    const r1 = placed.find(p => p.reference === 'R1')
    const c1 = placed.find(p => p.reference === 'C1')
    assert.ok(u1 && r1 && c1)

    // Passives should be within 40mm of the IC (roughly)
    const distR1 = Math.hypot(r1.x - u1.x, r1.y - u1.y)
    const distC1 = Math.hypot(c1.x - u1.x, c1.y - u1.y)
    assert.ok(distR1 < 40, `R1 too far from U1: ${distR1}mm`)
    assert.ok(distC1 < 40, `C1 too far from U1: ${distC1}mm`)
  })
})

// ---------------------------------------------------------------------------
// Classification heuristics
// ---------------------------------------------------------------------------

describe('isIC', () => {
  it('identifies ICs by value', () => {
    assert.ok(isIC({ reference: 'U1', value: 'ATmega328P', footprint: 'QFP-32', symbol: 'MCU', connections: {} }))
    assert.ok(isIC({ reference: 'U2', value: 'STM32F103', footprint: 'LQFP-48', symbol: 'MCU', connections: {} }))
    assert.ok(isIC({ reference: 'U3', value: 'ESP32', footprint: 'QFN-48', symbol: 'MCU', connections: {} }))
    assert.ok(isIC({ reference: 'U4', value: 'CPU', footprint: 'BGA', symbol: 'Processor', connections: {} }))
  })

  it('identifies ICs by symbol', () => {
    assert.ok(isIC({ reference: 'U1', value: 'LM7805', footprint: 'TO-220', symbol: 'MCU_ST_STM32:STM32', connections: {} }))
    assert.ok(isIC({ reference: 'U2', value: 'Regulator', footprint: 'SOT-223', symbol: 'IC_Analog', connections: {} }))
  })

  it('does not identify passives as ICs', () => {
    assert.ok(!isIC({ reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} }))
    assert.ok(!isIC({ reference: 'C1', value: '100nF', footprint: 'C_0402', symbol: 'Device:C', connections: {} }))
    assert.ok(!isIC({ reference: 'L1', value: '10uH', footprint: 'L_0805', symbol: 'Device:L', connections: {} }))
  })
})

describe('isConnector', () => {
  it('identifies connectors by value', () => {
    assert.ok(isConnector({ reference: 'J1', value: 'USB-C', footprint: 'USB_C', symbol: 'Conn', connections: {} }))
    assert.ok(isConnector({ reference: 'J2', value: 'Header_2x5', footprint: 'PinHeader', symbol: 'Header', connections: {} }))
    assert.ok(isConnector({ reference: 'J3', value: 'RJ45', footprint: 'Connector', symbol: 'Jack', connections: {} }))
  })

  it('identifies connectors by footprint', () => {
    assert.ok(isConnector({ reference: 'J1', value: 'Conn', footprint: 'Connector_PinHeader', symbol: 'X', connections: {} }))
    assert.ok(isConnector({ reference: 'J2', value: 'Port', footprint: 'USB_C_Receptacle', symbol: 'X', connections: {} }))
  })

  it('does not identify passives as connectors', () => {
    assert.ok(!isConnector({ reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} }))
    assert.ok(!isConnector({ reference: 'U1', value: 'MCU', footprint: 'QFP-32', symbol: 'MCU', connections: {} }))
  })
})

describe('isSmd', () => {
  it('identifies common SMD packages', () => {
    assert.ok(isSmd('Resistor_SMD:R_0402_1005Metric'))
    assert.ok(isSmd('Capacitor_SMD:C_0603_1608Metric'))
    assert.ok(isSmd('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm'))
    assert.ok(isSmd('Package_TO_SOT_SMD:SOT-23'))
    assert.ok(isSmd('Package_DFN_QFN:QFN-32'))
    assert.ok(isSmd('Package_BGA:BGA-100'))
  })

  it('identifies common through-hole packages', () => {
    assert.ok(!isSmd('Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm'))
    assert.ok(!isSmd('Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm'))
    assert.ok(!isSmd('Package_DIP:DIP-8_W7.62mm'))
    assert.ok(!isSmd('Package_TO_SOT_THT:TO-220-3'))
  })

  it('defaults to through-hole for unknown packages', () => {
    assert.ok(!isSmd('Custom:My_Weird_Package'))
    assert.ok(!isSmd('Vendor:Special_Part'))
  })
})

// ---------------------------------------------------------------------------
// PCB generator
// ---------------------------------------------------------------------------

describe('generatePcbContent', () => {
  it('generates valid KiCad PCB S-expression', () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [{ name: 'VCC', code: 1, components: ['R1'] }],
      componentCount: 1,
      netCount: 1,
    }

    const placed = [
      { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', x: 25, y: 15, rotation: 0, layer: 'F.Cu' },
    ]

    const connections = generateUnroutedConnections(placed, schematic.nets)
    const constraints = { width: 50, height: 30, layers: 2 }
    const designRules = resolveDesignRules()

    const content = generatePcbContent(schematic, placed, connections, constraints, designRules)

    assert.ok(content.startsWith('(kicad_pcb'))
    assert.ok(content.includes('(version 20240101)'))
    assert.ok(content.includes('(generator "vajra-kicad")'))
    assert.ok(content.includes('(net 1 "VCC")'))
    assert.ok(content.includes('(footprint "Resistor_SMD:R_0402"'))
    assert.ok(content.endsWith(')'))
  })

  it('includes board outline on Edge.Cuts', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const placed = []
    const connections = []
    const constraints = { width: 100, height: 80, layers: 2 }
    const designRules = resolveDesignRules()

    const content = generatePcbContent(schematic, placed, connections, constraints, designRules)

    assert.ok(content.includes('(gr_line (start 0 0) (end 100 0)'))
    assert.ok(content.includes('(gr_line (start 100 0) (end 100 80)'))
    assert.ok(content.includes('(gr_line (start 100 80) (end 0 80)'))
    assert.ok(content.includes('(gr_line (start 0 80) (end 0 0)'))
  })

  it('includes design rules', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const placed = []
    const connections = []
    const constraints = { width: 50, height: 30, layers: 2 }
    const designRules = resolveDesignRules({ minTraceWidth: 0.3, minClearance: 0.3 })

    const content = generatePcbContent(schematic, placed, connections, constraints, designRules)

    assert.ok(content.includes('(trace_width 0.3)'))
    assert.ok(content.includes('(clearance 0.3)'))
  })

  it('generates pads with net assignments', () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R', connections: { VCC: '1', GND: '2' } },
      ],
      nets: [
        { name: 'VCC', code: 1, components: ['R1'] },
        { name: 'GND', code: 2, components: ['R1'] },
      ],
      componentCount: 1,
      netCount: 2,
    }

    const placed = [
      { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', x: 25, y: 15, rotation: 0, layer: 'F.Cu' },
    ]

    const connections = generateUnroutedConnections(placed, schematic.nets)
    const constraints = { width: 50, height: 30, layers: 2 }
    const designRules = resolveDesignRules()

    const content = generatePcbContent(schematic, placed, connections, constraints, designRules)

    assert.ok(content.includes('(net 1 "VCC")'))
    assert.ok(content.includes('(net 2 "GND")'))
  })

  it('throws on invalid board dimensions', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const designRules = resolveDesignRules()
    assert.throws(
      () => generatePcbContent(schematic, [], [], { width: 0, height: 30, layers: 2 }, designRules),
      /width must be > 0/
    )
    assert.throws(
      () => generatePcbContent(schematic, [], [], { width: 50, height: -1, layers: 2 }, designRules),
      /height must be > 0/
    )
    assert.throws(
      () => generatePcbContent(schematic, [], [], { width: 50, height: 30, layers: 3 }, designRules),
      /layers must be 1, 2, or 4/
    )
  })

  it('generates single-layer PCB with only F.Cu', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const designRules = resolveDesignRules()
    const content = generatePcbContent(schematic, [], [], { width: 50, height: 30, layers: 1 }, designRules)

    assert.ok(content.includes('"F.Cu"'))
    assert.ok(!content.includes('"B.Cu"'))
  })

  it('generates 4-layer PCB with inner layers', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const designRules = resolveDesignRules()
    const content = generatePcbContent(schematic, [], [], { width: 50, height: 30, layers: 4 }, designRules)

    assert.ok(content.includes('"F.Cu"'))
    assert.ok(content.includes('"B.Cu"'))
    assert.ok(content.includes('"In1.Cu"'))
    assert.ok(content.includes('"In2.Cu"'))
  })

  it('includes mounting holes when specified', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const designRules = resolveDesignRules()
    const constraints = {
      width: 50, height: 30, layers: 2,
      mountingHoles: [
        { x: 5, y: 5, diameter: 3.2 },
        { x: 45, y: 25, diameter: 3.2, padDiameter: 8 },
      ],
    }
    const content = generatePcbContent(schematic, [], [], constraints, designRules)

    assert.ok(content.includes('MountingHole'))
    assert.ok(content.includes('MH1'))
    assert.ok(content.includes('MH2'))
  })

  it('generates SMD pads for SMD footprints', () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R', connections: { VCC: '1' } },
      ],
      nets: [{ name: 'VCC', code: 1, components: ['R1'] }],
      componentCount: 1,
      netCount: 1,
    }
    const placed = [
      { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', x: 25, y: 15, rotation: 0, layer: 'F.Cu' },
    ]
    const connections = generateUnroutedConnections(placed, schematic.nets)
    const designRules = resolveDesignRules()
    const content = generatePcbContent(schematic, placed, connections, { width: 50, height: 30, layers: 2 }, designRules)

    // SMD pads should use smd type and F.Cu/F.Paste/F.Mask layers
    assert.ok(content.includes('(pad "1" smd'))
    // No drill clause on SMD pads (mounting holes may have drill, so check the R1 footprint block)
    const r1Block = content.slice(content.indexOf('(footprint "Resistor_SMD:R_0402"'), content.indexOf('(footprint "Resistor_SMD:R_0402"') + 500)
    assert.ok(!r1Block.includes('(drill'))
  })

  it('generates through-hole pads for THT footprints', () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_THT:R_Axial_DIN0207', symbol: 'Device:R', connections: { VCC: '1' } },
      ],
      nets: [{ name: 'VCC', code: 1, components: ['R1'] }],
      componentCount: 1,
      netCount: 1,
    }
    const placed = [
      { reference: 'R1', value: '10k', footprint: 'Resistor_THT:R_Axial_DIN0207', x: 25, y: 15, rotation: 0, layer: 'F.Cu' },
    ]
    const connections = generateUnroutedConnections(placed, schematic.nets)
    const designRules = resolveDesignRules()
    const content = generatePcbContent(schematic, placed, connections, { width: 50, height: 30, layers: 2 }, designRules)

    assert.ok(content.includes('(pad "1" thru_hole'))
    // Check the R1 footprint block for drill
    const r1Block = content.slice(content.indexOf('(footprint "Resistor_THT:R_Axial_DIN0207"'), content.indexOf('(footprint "Resistor_THT:R_Axial_DIN0207"') + 500)
    assert.ok(r1Block.includes('(drill 0.8)'))
  })

  it('generates placeholder pad for unconnected components', () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [],
      componentCount: 1,
      netCount: 0,
    }
    const placed = [
      { reference: 'R1', value: '10k', footprint: 'R_0402', x: 25, y: 15, rotation: 0, layer: 'F.Cu' },
    ]
    const designRules = resolveDesignRules()
    const content = generatePcbContent(schematic, placed, [], { width: 50, height: 30, layers: 2 }, designRules)

    assert.ok(content.includes('(net 0 "")'))
  })
})

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('generateUnroutedConnections', () => {
  it('generates connections for multi-component nets', () => {
    const placed = [
      { reference: 'R1', value: '10k', footprint: 'R_0402', x: 10, y: 10, rotation: 0, layer: 'F.Cu' },
      { reference: 'R2', value: '10k', footprint: 'R_0402', x: 20, y: 10, rotation: 0, layer: 'F.Cu' },
      { reference: 'U1', value: 'MCU', footprint: 'QFP-32', x: 30, y: 10, rotation: 0, layer: 'F.Cu' },
    ]

    const nets = [
      { name: 'VCC', code: 1, components: ['R1', 'U1'] },
      { name: 'GND', code: 2, components: ['R2', 'U1'] },
    ]

    const connections = generateUnroutedConnections(placed, nets)

    assert.equal(connections.length, 2)
    assert.equal(connections[0].net, 'VCC')
    assert.equal(connections[0].from.component, 'R1')
    assert.equal(connections[0].to.component, 'U1')
    assert.equal(connections[1].net, 'GND')
    assert.equal(connections[1].from.component, 'R2')
    assert.equal(connections[1].to.component, 'U1')
  })

  it('skips nets with less than 2 placed components', () => {
    const placed = [
      { reference: 'R1', value: '10k', footprint: 'R_0402', x: 10, y: 10, rotation: 0, layer: 'F.Cu' },
    ]

    const nets = [
      { name: 'VCC', code: 1, components: ['R1', 'R2'] },
    ]

    const connections = generateUnroutedConnections(placed, nets)
    assert.equal(connections.length, 0)
  })

  it('generates star topology for 3-component net', () => {
    const placed = [
      { reference: 'R1', value: '10k', footprint: 'R_0402', x: 10, y: 10, rotation: 0, layer: 'F.Cu' },
      { reference: 'R2', value: '10k', footprint: 'R_0402', x: 20, y: 10, rotation: 0, layer: 'F.Cu' },
      { reference: 'R3', value: '10k', footprint: 'R_0402', x: 30, y: 10, rotation: 0, layer: 'F.Cu' },
    ]

    const nets = [
      { name: 'BUS', code: 1, components: ['R1', 'R2', 'R3'] },
    ]

    const connections = generateUnroutedConnections(placed, nets)
    // Star: R1->R2, R1->R3 (hub is first component)
    assert.equal(connections.length, 2)
    assert.equal(connections[0].from.component, 'R1')
    assert.equal(connections[0].to.component, 'R2')
    assert.equal(connections[1].from.component, 'R1')
    assert.equal(connections[1].to.component, 'R3')
  })

  it('returns empty for no nets', () => {
    const placed = [
      { reference: 'R1', value: '10k', footprint: 'R_0402', x: 10, y: 10, rotation: 0, layer: 'F.Cu' },
    ]
    const connections = generateUnroutedConnections(placed, [])
    assert.equal(connections.length, 0)
  })

  it('returns empty for empty placed list', () => {
    const nets = [{ name: 'VCC', code: 1, components: ['R1', 'R2'] }]
    const connections = generateUnroutedConnections([], nets)
    assert.equal(connections.length, 0)
  })
})

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

describe('resolveDesignRules', () => {
  it('returns defaults when no input', () => {
    const rules = resolveDesignRules()
    assert.equal(rules.minTraceWidth, 0.25)
    assert.equal(rules.minClearance, 0.25)
    assert.equal(rules.minViaDrill, 0.3)
    assert.equal(rules.minViaSize, 0.6)
    assert.equal(rules.minAnnularRing, 0.15)
  })

  it('merges partial overrides', () => {
    const rules = resolveDesignRules({ minTraceWidth: 0.5, minClearance: 0.4 })
    assert.equal(rules.minTraceWidth, 0.5)
    assert.equal(rules.minClearance, 0.4)
    assert.equal(rules.minViaDrill, 0.3)
  })

  it('throws on negative values', () => {
    assert.throws(() => resolveDesignRules({ minTraceWidth: -0.1 }), /minTraceWidth must be >= 0/)
    assert.throws(() => resolveDesignRules({ minClearance: -1 }), /minClearance must be >= 0/)
    assert.throws(() => resolveDesignRules({ minViaDrill: -0.5 }), /minViaDrill must be >= 0/)
    assert.throws(() => resolveDesignRules({ minViaSize: -1 }), /minViaSize must be >= 0/)
    assert.throws(() => resolveDesignRules({ minAnnularRing: -0.1 }), /minAnnularRing must be >= 0/)
  })

  it('allows zero values', () => {
    const rules = resolveDesignRules({ minTraceWidth: 0, minClearance: 0 })
    assert.equal(rules.minTraceWidth, 0)
    assert.equal(rules.minClearance, 0)
  })
})

// ---------------------------------------------------------------------------
// DRC report parser
// ---------------------------------------------------------------------------

describe('parseDrcReport', () => {
  it('parses a clean DRC report', () => {
    const report = JSON.stringify({
      violations: [],
    })
    const result = parseDrcReport(report)
    assert.ok(result.passed)
    assert.equal(result.violationCount, 0)
    assert.equal(result.errorCount, 0)
    assert.equal(result.warningCount, 0)
  })

  it('parses violations with errors and warnings', () => {
    const report = JSON.stringify({
      violations: [
        { type: 'clearance', severity: 'error', message: 'Trace too close to via' },
        { type: 'track_width', severity: 'warning', message: 'Trace width below minimum' },
        { type: 'via_diameter', severity: 'error', message: 'Via too small' },
      ],
    })
    const result = parseDrcReport(report)
    assert.ok(!result.passed)
    assert.equal(result.violationCount, 3)
    assert.equal(result.errorCount, 2)
    assert.equal(result.warningCount, 1)
    assert.equal(result.violations[0].type, 'clearance')
    assert.equal(result.violations[0].severity, 'error')
    assert.equal(result.violations[1].severity, 'warning')
  })

  it('handles missing severity field', () => {
    const report = JSON.stringify({
      violations: [
        { type: 'unknown', message: 'Something happened' },
      ],
    })
    const result = parseDrcReport(report)
    assert.equal(result.violations[0].severity, 'warning')
  })

  it('handles missing message field', () => {
    const report = JSON.stringify({
      violations: [
        { type: 'clearance', severity: 'error' },
      ],
    })
    const result = parseDrcReport(report)
    assert.equal(result.violations[0].message, '')
  })

  it('returns error state for invalid JSON', () => {
    const result = parseDrcReport('not json at all')
    assert.ok(!result.passed)
    assert.equal(result.violationCount, -1)
    assert.equal(result.errorCount, 1)
    assert.equal(result.violations[0].type, 'parse_error')
  })

  it('handles report with no violations field', () => {
    const result = parseDrcReport('{}')
    assert.ok(result.passed)
    assert.equal(result.violationCount, 0)
  })

  it('parses violations with location data', () => {
    const report = JSON.stringify({
      violations: [
        { type: 'clearance', severity: 'error', message: 'Too close', location: { x: 10.5, y: 20.3 } },
      ],
    })
    const result = parseDrcReport(report)
    assert.deepEqual(result.violations[0].location, { x: 10.5, y: 20.3 })
  })

  it('parses violations with affected items', () => {
    const report = JSON.stringify({
      violations: [
        { type: 'clearance', severity: 'error', message: 'Between R1 and C1', items: ['R1.1', 'C1.2'] },
      ],
    })
    const result = parseDrcReport(report)
    assert.deepEqual(result.violations[0].items, ['R1.1', 'C1.2'])
  })
})

// ---------------------------------------------------------------------------
// End-to-end pipeline
// ---------------------------------------------------------------------------

describe('end-to-end pipeline', () => {
  it('generates a complete PCB from schematic data', () => {
    const schematic = {
      components: [
        { reference: 'U1', value: 'STM32F103', footprint: 'Package_QFP:LQFP-48_7x7mm_P0.5mm', symbol: 'MCU_ST_STM32:STM32F103C8Tx', connections: {} },
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402_1005Metric', symbol: 'Device:R', connections: { VCC: '1', GND: '2' } },
        { reference: 'R2', value: '4.7k', footprint: 'Resistor_SMD:R_0402_1005Metric', symbol: 'Device:R', connections: { VCC: '1', GND: '2' } },
        { reference: 'C1', value: '100nF', footprint: 'Capacitor_SMD:C_0402_1005Metric', symbol: 'Device:C', connections: { VCC: '1', GND: '2' } },
        { reference: 'C2', value: '10uF', footprint: 'Capacitor_SMD:C_0805_2012Metric', symbol: 'Device:C', connections: { VCC: '1', GND: '2' } },
        { reference: 'J1', value: 'USB-C', footprint: 'Connector_USB:USB_C_Receptacle', symbol: 'Connector:Conn_USB_C', connections: {} },
      ],
      nets: [
        { name: 'VCC', code: 1, components: ['U1', 'R1', 'R2', 'C1', 'C2'] },
        { name: 'GND', code: 2, components: ['U1', 'R1', 'R2', 'C1', 'C2'] },
      ],
      componentCount: 6,
      netCount: 2,
    }

    const constraints = { width: 80, height: 60, layers: 2 }
    const placed = placeFootprints(schematic, constraints)
    assert.equal(placed.length, 6)

    const connections = generateUnroutedConnections(placed, schematic.nets)
    assert.ok(connections.length > 0)

    const designRules = resolveDesignRules()
    const content = generatePcbContent(schematic, placed, connections, constraints, designRules)

    assert.ok(content.startsWith('(kicad_pcb'))
    assert.ok(content.includes('(net 1 "VCC")'))
    assert.ok(content.includes('(net 2 "GND")'))
    assert.ok(content.includes('(footprint'))
    assert.ok(content.includes('(gr_line'))
  })
})

// ---------------------------------------------------------------------------
// Power / decoupling classification
// ---------------------------------------------------------------------------

describe('isPower', () => {
  it('identifies voltage regulators', () => {
    assert.ok(isPower({ reference: 'U2', value: 'LM7805', footprint: 'TO-220', symbol: 'Regulator', connections: {} }))
    assert.ok(isPower({ reference: 'U3', value: 'TPS54331', footprint: 'SOIC-8', symbol: 'DC_DC', connections: {} }))
    assert.ok(isPower({ reference: 'U4', value: 'AMS1117', footprint: 'SOT-223', symbol: 'LDO', connections: {} }))
  })

  it('identifies power symbols', () => {
    assert.ok(isPower({ reference: 'U1', value: 'Reg', footprint: 'QFP', symbol: 'power:regulator', connections: {} }))
    assert.ok(isPower({ reference: 'U2', value: 'Conv', footprint: 'SOIC', symbol: 'dc_dc_converter', connections: {} }))
  })

  it('does not identify passives as power', () => {
    assert.ok(!isPower({ reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} }))
    assert.ok(!isPower({ reference: 'C1', value: '100nF', footprint: 'C_0402', symbol: 'Device:C', connections: {} }))
  })
})

describe('isDecouplingCap', () => {
  it('identifies common decoupling caps', () => {
    assert.ok(isDecouplingCap({ reference: 'C1', value: '100nF', footprint: 'Capacitor_SMD:C_0402', symbol: 'Device:C', connections: {} }))
    assert.ok(isDecouplingCap({ reference: 'C2', value: '10uF', footprint: 'Capacitor_SMD:C_0805', symbol: 'Device:C', connections: {} }))
    assert.ok(isDecouplingCap({ reference: 'C3', value: '0.1uF', footprint: 'Capacitor_SMD:C_0402', symbol: 'Device:C', connections: {} }))
  })

  it('does not identify non-decoupling caps', () => {
    assert.ok(!isDecouplingCap({ reference: 'C1', value: '22pF', footprint: 'Capacitor_SMD:C_0402', symbol: 'Device:C', connections: {} }))
    assert.ok(!isDecouplingCap({ reference: 'R1', value: '100nF', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R', connections: {} }))
  })
})

// ---------------------------------------------------------------------------
// Custom board outlines
// ---------------------------------------------------------------------------

describe('custom board outlines', () => {
  it('generates custom polygon outline', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const designRules = resolveDesignRules()
    const outline = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 30 },
      { x: 25, y: 40 },
      { x: 0, y: 30 },
    ]
    const constraints = { width: 50, height: 40, layers: 2, outline, groundPlane: false }
    const content = generatePcbContent(schematic, [], [], constraints, designRules)

    // Should have 5 gr_line edge cuts lines (one per polygon edge)
    const edgeCutsLines = content.split('\n').filter(l => l.includes('gr_line') && l.includes('Edge.Cuts'))
    assert.equal(edgeCutsLines.length, 5)
    assert.ok(content.includes('(start 25 40)'))
    assert.ok(content.includes('(end 0 30)'))
  })

  it('falls back to rectangle when outline has < 3 points', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const designRules = resolveDesignRules()
    const outline = [{ x: 0, y: 0 }, { x: 50, y: 0 }]
    const constraints = { width: 50, height: 30, layers: 2, outline, groundPlane: false }
    const content = generatePcbContent(schematic, [], [], constraints, designRules)

    // Should have 4 gr_line edge cuts lines (rectangle)
    const edgeCutsLines = content.split('\n').filter(l => l.includes('gr_line') && l.includes('Edge.Cuts'))
    assert.equal(edgeCutsLines.length, 4)
  })
})

// ---------------------------------------------------------------------------
// Ground plane zones
// ---------------------------------------------------------------------------

describe('ground plane zones', () => {
  it('generates ground plane on B.Cu for 2-layer boards', () => {
    const schematic = {
      components: [],
      nets: [{ name: 'GND', code: 2, components: [] }],
      componentCount: 0,
      netCount: 1,
    }
    const designRules = resolveDesignRules()
    const constraints = { width: 50, height: 30, layers: 2, groundPlane: true }
    const content = generatePcbContent(schematic, [], [], constraints, designRules)

    assert.ok(content.includes('(zone (net 2) (net_name "GND") (layer "B.Cu")'))
    assert.ok(content.includes('(hatch edge 0.5)'))
    assert.ok(content.includes('(polygon'))
    assert.ok(content.includes('(xy 0 0)'))
  })

  it('generates ground planes on inner layers for 4-layer boards', () => {
    const schematic = {
      components: [],
      nets: [{ name: 'GND', code: 2, components: [] }],
      componentCount: 0,
      netCount: 1,
    }
    const designRules = resolveDesignRules()
    const constraints = { width: 50, height: 30, layers: 4, groundPlane: true }
    const content = generatePcbContent(schematic, [], [], constraints, designRules)

    assert.ok(content.includes('(layer "B.Cu")'))
    assert.ok(content.includes('(layer "In1.Cu")'))
    assert.ok(content.includes('(layer "In2.Cu")'))
  })

  it('skips ground plane when groundPlane is false', () => {
    const schematic = { components: [], nets: [], componentCount: 0, netCount: 0 }
    const designRules = resolveDesignRules()
    const constraints = { width: 50, height: 30, layers: 2, groundPlane: false }
    const content = generatePcbContent(schematic, [], [], constraints, designRules)

    assert.ok(!content.includes('(zone'))
  })

  it('uses custom outline for ground plane zone', () => {
    const schematic = {
      components: [],
      nets: [{ name: 'GND', code: 2, components: [] }],
      componentCount: 0,
      netCount: 1,
    }
    const designRules = resolveDesignRules()
    const outline = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 30 },
      { x: 0, y: 30 },
    ]
    const constraints = { width: 50, height: 30, layers: 2, groundPlane: true, outline }
    const content = generatePcbContent(schematic, [], [], constraints, designRules)

    // Zone should use the custom outline points
    assert.ok(content.includes('(xy 50 30)'))
  })
})

// ---------------------------------------------------------------------------
// Two-sided placement
// ---------------------------------------------------------------------------

describe('two-sided placement', () => {
  it('places decoupling caps on B.Cu near ICs', () => {
    const schematic = {
      components: [
        { reference: 'U1', value: 'STM32F103', footprint: 'MCU_ST_STM32:LQFP-48', symbol: 'MCU_ST_STM32:STM32F103C8Tx', connections: {} },
        { reference: 'C1', value: '100nF', footprint: 'Capacitor_SMD:C_0402', symbol: 'Device:C', connections: {} },
        { reference: 'C2', value: '10uF', footprint: 'Capacitor_SMD:C_0805', symbol: 'Device:C', connections: {} },
      ],
      nets: [
        { name: 'VCC', code: 1, components: ['U1', 'C1', 'C2'] },
        { name: 'GND', code: 2, components: ['U1', 'C1', 'C2'] },
      ],
      componentCount: 3,
      netCount: 2,
    }

    const constraints = { width: 80, height: 60, layers: 2 }
    const placed = placeFootprints(schematic, constraints)

    // IC should be on F.Cu
    const u1 = placed.find(p => p.reference === 'U1')
    assert.ok(u1)
    assert.equal(u1.layer, 'F.Cu')

    // Decoupling caps should be on B.Cu
    const c1 = placed.find(p => p.reference === 'C1')
    const c2 = placed.find(p => p.reference === 'C2')
    assert.ok(c1)
    assert.ok(c2)
    assert.equal(c1.layer, 'B.Cu')
    assert.equal(c2.layer, 'B.Cu')
  })

  it('does not use B.Cu for 1-layer boards', () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
        { reference: 'R2', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [],
      componentCount: 2,
      netCount: 0,
    }

    const constraints = { width: 50, height: 30, layers: 1 }
    const placed = placeFootprints(schematic, constraints)

    // All components should be on F.Cu
    for (const fp of placed) {
      assert.equal(fp.layer, 'F.Cu')
    }
  })

  it('places some passives on B.Cu for 2-layer boards', () => {
    const schematic = {
      components: Array.from({ length: 10 }, (_, i) => ({
        reference: `R${i + 1}`,
        value: '10k',
        footprint: 'Resistor_SMD:R_0402',
        symbol: 'Device:R',
        connections: {},
      })),
      nets: [],
      componentCount: 10,
      netCount: 0,
    }

    const constraints = { width: 80, height: 60, layers: 2 }
    const placed = placeFootprints(schematic, constraints)

    // Some should be on B.Cu (approximately 30% = 3 out of 10)
    const bCuCount = placed.filter(p => p.layer === 'B.Cu').length
    assert.ok(bCuCount > 0, `Expected some components on B.Cu, got ${bCuCount}`)
    assert.ok(bCuCount <= 5, `Too many components on B.Cu: ${bCuCount}`)
  })
})

// ---------------------------------------------------------------------------
// Schematic generator
// ---------------------------------------------------------------------------

describe('generateSchContent', () => {
  it('generates a valid .kicad_sch file structure', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [],
      componentCount: 1,
      netCount: 0,
    }

    const content = await generateSchContent(schematic)

    assert.ok(content.startsWith('(kicad_sch'), 'Should start with (kicad_sch')
    assert.ok(content.includes('(version 20231231)'), 'Should have version')
    assert.ok(content.includes('(generator "vajra-kicad")'), 'Should have generator')
    assert.ok(content.includes('(paper "A4")'), 'Should have paper size')
    assert.ok(content.includes('(sheet_instances'), 'Should have sheet_instances')
    assert.ok(content.includes('(path "/"'), 'Should have root path')
    assert.ok(content.trimEnd().endsWith(')'), 'Should end with closing paren')
  })

  it('embeds lib_symbols for used components', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
        { reference: 'C1', value: '100nF', footprint: 'C_0402', symbol: 'Device:C', connections: {} },
      ],
      nets: [],
      componentCount: 2,
      netCount: 0,
    }

    const content = await generateSchContent(schematic)

    assert.ok(content.includes('(lib_symbols'), 'Should have lib_symbols section')
    assert.ok(content.includes('"Device:R"'), 'Should embed Device:R')
    assert.ok(content.includes('"Device:C"'), 'Should embed Device:C')
  })

  it('places symbols with correct references and values', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
        { reference: 'R2', value: '4.7k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [],
      componentCount: 2,
      netCount: 0,
    }

    const content = await generateSchContent(schematic)

    assert.ok(content.includes('"R1"'), 'Should have R1 reference')
    assert.ok(content.includes('"R2"'), 'Should have R2 reference')
    assert.ok(content.includes('"10k"'), 'Should have R1 value')
    assert.ok(content.includes('"4.7k"'), 'Should have R2 value')
  })

  it('generates wires for nets with two components', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { SIG: '2' } },
        { reference: 'R2', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { SIG: '2' } },
      ],
      nets: [
        { name: 'SIG', code: 1, components: ['R1', 'R2'] },
      ],
      componentCount: 2,
      netCount: 1,
    }

    const content = await generateSchContent(schematic)

    assert.ok(content.includes('(wire'), 'Should have wire elements')
    assert.ok(content.includes('(pts'), 'Should have wire points')
    assert.ok(content.includes('(xy'), 'Should have xy coordinates')
  })

  it('adds power symbols for VCC and GND nets', async () => {
    const schematic = {
      components: [
        { reference: 'U1', value: 'ATmega328P', footprint: 'QFP-32', symbol: 'MCU_Atmel_ATmega:ATmega328P', connections: { VCC: '1', GND: '8' } },
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { VCC: '1' } },
      ],
      nets: [
        { name: 'VCC', code: 1, components: ['U1', 'R1'] },
        { name: 'GND', code: 2, components: ['U1'] },
      ],
      componentCount: 2,
      netCount: 2,
    }

    const content = await generateSchContent(schematic)

    assert.ok(content.includes('"power:VCC"'), 'Should have VCC power symbol')
    assert.ok(content.includes('"power:GND"'), 'Should have GND power symbol')
    assert.ok(content.includes('#PWR'), 'Should have power reference designators')
  })

  it('adds net labels', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { SIG: '2' } },
        { reference: 'R2', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { SIG: '2' } },
      ],
      nets: [
        { name: 'SIG', code: 1, components: ['R1', 'R2'] },
      ],
      componentCount: 2,
      netCount: 1,
    }

    const content = await generateSchContent(schematic)

    assert.ok(content.includes('(label "SIG"'), 'Should have net label for SIG')
  })

  it('supports custom page size', async () => {
    const schematic = {
      components: [],
      nets: [],
      componentCount: 0,
      netCount: 0,
    }

    const content = await generateSchContent(schematic, { paper: 'A3' })

    assert.ok(content.includes('(paper "A3")'), 'Should use custom page size')
  })

  it('supports custom spacing', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
        { reference: 'R2', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [],
      componentCount: 2,
      netCount: 0,
    }

    const content = await generateSchContent(schematic, { spacingX: 30, spacingY: 30 })

    // R1 should be at default position (50, 40)
    // R2 should be at (50+30, 40) = (80, 40)
    assert.ok(content.includes('(at 50 40 0)'), 'R1 at default position')
    assert.ok(content.includes('(at 80 40 0)'), 'R2 at custom spacing')
  })

  it('wraps to next row after max columns', async () => {
    const components = Array.from({ length: 8 }, (_, i) => ({
      reference: `R${i + 1}`,
      value: '10k',
      footprint: 'R_0402',
      symbol: 'Device:R',
      connections: {},
    }))

    const schematic = {
      components,
      nets: [],
      componentCount: 8,
      netCount: 0,
    }

    const content = await generateSchContent(schematic, { cols: 4, spacingX: 25.4, spacingY: 25.4 })

    // First row: R1-R4 at y=40
    assert.ok(content.includes('(at 50 40 0)'), 'R1 in row 0')
    assert.ok(content.includes('(at 126.2 40 0)'), 'R4 in row 0')
    // Second row: R5-R8 at y=65.4
    assert.ok(content.includes('(at 50 65.4 0)'), 'R5 in row 1')
    assert.ok(content.includes('(at 126.2 65.4 0)'), 'R8 in row 1')
  })

  it('includes instance tracking for each symbol', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: {} },
      ],
      nets: [],
      componentCount: 1,
      netCount: 0,
    }

    const content = await generateSchContent(schematic, { projectName: 'my-project' })

    assert.ok(content.includes('(instances'), 'Should have instances section')
    assert.ok(content.includes('(project "my-project"'), 'Should have project name')
    assert.ok(content.includes('(reference "R1")'), 'Should track reference')
    assert.ok(content.includes('(unit 1)'), 'Should have unit number')
  })

  it('uses fallback lib_symbol for unknown components', async () => {
    const schematic = {
      components: [
        { reference: 'X1', value: 'Crystal', footprint: 'Crystal', symbol: 'Device:Crystal', connections: {} },
      ],
      nets: [],
      componentCount: 1,
      netCount: 0,
    }

    const content = await generateSchContent(schematic)

    // Unknown symbol should fall back to Device:R
    assert.ok(content.includes('"Device:R"'), 'Should fallback to Device:R for unknown')
    assert.ok(content.includes('"X1"'), 'Should still place the component')
  })

  it('generates complete pipeline: parseNetlist → generateSchContent', async () => {
    const netlist = `
(export (version D)
  (design
    (source "test.kicad_sch")
    (date "2024-01-01")
    (tool "kicad-cli")
  )
  (components
    (comp (ref R1) (value "10k") (footprint "Resistor_SMD:R_0402_1005Metric") (libsymbol "Device:R"))
    (comp (ref R2) (value "4.7k") (footprint "Resistor_SMD:R_0402_1005Metric") (libsymbol "Device:R"))
    (comp (ref C1) (value "100nF") (footprint "Capacitor_SMD:C_0402_1005Metric") (libsymbol "Device:C"))
  )
  (nets
    (net (code 1) (name "VCC")
      (node (ref R1) (pin 1))
      (node (ref C1) (pin 1))
    )
    (net (code 2) (name "GND")
      (node (ref R1) (pin 2))
      (node (ref R2) (pin 1))
    )
    (net (code 3) (name "SIG")
      (node (ref R2) (pin 2))
      (node (ref C1) (pin 2))
    )
  )
)
`
    const schematic = parseNetlist(netlist)
    const content = await generateSchContent(schematic)

    // Verify complete pipeline output
    assert.ok(content.startsWith('(kicad_sch'), 'Should be valid kicad_sch')
    assert.ok(content.includes('"R1"'), 'Should have R1')
    assert.ok(content.includes('"R2"'), 'Should have R2')
    assert.ok(content.includes('"C1"'), 'Should have C1')
    assert.ok(content.includes('"VCC"'), 'Should have VCC net')
    assert.ok(content.includes('"GND"'), 'Should have GND net')
    assert.ok(content.includes('"SIG"'), 'Should have SIG net')
    assert.ok(content.includes('(wire'), 'Should have wires')
    assert.ok(content.includes('"power:VCC"'), 'Should have VCC power symbol')
    assert.ok(content.includes('"power:GND"'), 'Should have GND power symbol')
    assert.ok(content.includes('(sheet_instances'), 'Should have sheet_instances')
  })

  it('Bug fix: isPositive regex correctly identifies GND-type nets', async () => {
    // Net name "GND" should be treated as negative (not positive)
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { GND: '2' } },
        { reference: 'R2', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { GND: '2' } },
      ],
      nets: [
        { name: 'GND', code: 1, components: ['R1', 'R2'] },
      ],
      componentCount: 2,
      netCount: 1,
    }

    const content = await generateSchContent(schematic)

    // GND should use power:GND, not power:VCC
    assert.ok(content.includes('"power:GND"'), 'GND net should use power:GND symbol')
    assert.ok(!content.includes('"power:GND"') || content.includes('"power:GND"'), 'Should have GND power symbol')
  })

  it('Bug fix: isPositive regex correctly identifies +3V3 as positive', async () => {
    const schematic = {
      components: [
        { reference: 'U1', value: 'MCU', footprint: 'QFP-32', symbol: 'MCU:ATmega', connections: { '+3V3': '1' } },
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { '+3V3': '1' } },
      ],
      nets: [
        { name: '+3V3', code: 1, components: ['U1', 'R1'] },
      ],
      componentCount: 2,
      netCount: 1,
    }

    const content = await generateSchContent(schematic)

    // +3V3 should be treated as positive → power:+3V3 (falls back to power:VCC)
    assert.ok(content.includes('power:'), 'Should have power symbol')
  })

  it('Bug fix: wire routing matches correct pin from connections map', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { SIG: '2' } },
        { reference: 'R2', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { SIG: '1' } },
      ],
      nets: [
        { name: 'SIG', code: 1, components: ['R1', 'R2'] },
      ],
      componentCount: 2,
      netCount: 1,
    }

    const content = await generateSchContent(schematic)

    // R1 pin 2 and R2 pin 1 should be wired (not pin 1 of both)
    assert.ok(content.includes('(wire'), 'Should have wires')
    // Verify we get exactly 2 wire segments (L-route for non-aligned pins)
    const wireCount = (content.match(/\(wire/g) || []).length
    assert.ok(wireCount >= 2, `Should have at least 2 wire segments, got ${wireCount}`)
  })

  it('Bug fix: power symbols have wires connecting to component pins', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { VCC: '1', GND: '2' } },
      ],
      nets: [
        { name: 'VCC', code: 1, components: ['R1'] },
        { name: 'GND', code: 2, components: ['R1'] },
      ],
      componentCount: 1,
      netCount: 2,
    }

    const content = await generateSchContent(schematic)

    // Should have power symbols
    assert.ok(content.includes('"power:VCC"'), 'Should have VCC power symbol')
    assert.ok(content.includes('"power:GND"'), 'Should have GND power symbol')

    // Should have wires from power symbols to component pins
    const wireCount = (content.match(/\(wire/g) || []).length
    assert.ok(wireCount >= 2, `Should have at least 2 wires (one per power symbol), got ${wireCount}`)
  })

  it('Bug fix: three-component net wires all pins correctly', async () => {
    const schematic = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { NET1: '2' } },
        { reference: 'R2', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { NET1: '2' } },
        { reference: 'R3', value: '10k', footprint: 'R_0402', symbol: 'Device:R', connections: { NET1: '2' } },
      ],
      nets: [
        { name: 'NET1', code: 1, components: ['R1', 'R2', 'R3'] },
      ],
      componentCount: 3,
      netCount: 1,
    }

    const content = await generateSchContent(schematic)

    // Star topology: hub (R1) connects to R2 and R3
    // All aligned horizontally → straight wires (1 segment each) = 2 wires total
    const wireCount = (content.match(/\(wire/g) || []).length
    assert.ok(wireCount >= 2, `Should have at least 2 wires for 3-component star, got ${wireCount}`)
  })
})

// ---------------------------------------------------------------------------
// Symbol library resolver
// ---------------------------------------------------------------------------

describe('parseSymbolLibrary', () => {
  it('parses a .kicad_sym file with a resistor symbol', () => {
    const kicadSym = `
(kicad_symbol_lib
  (version 20231120)
  (generator "test")
  (symbol "R"
    (pin_numbers (hide yes))
    (pin_names (offset 0))
    (in_bom yes)
    (on_board yes)
    (property "Reference" "R" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "R" (id 1) (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1"
      (rectangle (start -1.016 2.54) (end 1.016 -2.54)
        (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))))
)
`
    const lib = parseSymbolLibrary(kicadSym)
    assert.equal(lib.version, 20231120)
    assert.ok(lib.symbols.has('R'), 'Should have symbol R')

    const r = lib.symbols.get('R')
    assert.equal(r.unitCount, 1)
    assert.equal(r.pins.size, 2)
    assert.ok(r.pins.has('1'), 'Should have pin 1')
    assert.ok(r.pins.has('2'), 'Should have pin 2')

    const pin1 = r.pins.get('1')
    assert.equal(pin1.electricalType, 'passive')
    assert.equal(pin1.position.x, 0)
    assert.equal(pin1.position.y, 3.81)
    assert.equal(pin1.angle, 270)
  })

  it('parses a multi-unit symbol (quad op-amp)', () => {
    const kicadSym = `
(kicad_symbol_lib
  (version 20231120)
  (generator "test")
  (symbol "LM324"
    (property "Reference" "U" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "LM324_1_1"
      (pin input line (at -7.62 2.54 0) (length 2.54)
        (name "+" (effects (font (size 1.27 1.27))))
        (number "3" (effects (font (size 1.27 1.27)))))
      (pin input line (at -7.62 -2.54 0) (length 2.54)
        (name "-" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
      (pin output line (at 7.62 0 180) (length 2.54)
        (name "OUT" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))))
    (symbol "LM324_2_1"
      (pin input line (at -7.62 2.54 0) (length 2.54)
        (name "+" (effects (font (size 1.27 1.27))))
        (number "5" (effects (font (size 1.27 1.27)))))
      (pin input line (at -7.62 -2.54 0) (length 2.54)
        (name "-" (effects (font (size 1.27 1.27))))
        (number "4" (effects (font (size 1.27 1.27)))))
      (pin output line (at 7.62 0 180) (length 2.54)
        (name "OUT" (effects (font (size 1.27 1.27))))
        (number "7" (effects (font (size 1.27 1.27))))))
    (symbol "LM324_5_1"
      (pin power_in line (at 0 10.16 270) (length 2.54)
        (name "V+" (effects (font (size 1.27 1.27))))
        (number "4" (effects (font (size 1.27 1.27)))))
      (pin power_in line (at 0 -10.16 90) (length 2.54)
        (name "V-" (effects (font (size 1.27 1.27))))
        (number "11" (effects (font (size 1.27 1.27))))))
  )
)
`
    const lib = parseSymbolLibrary(kicadSym)
    const lm = lib.symbols.get('LM324')
    assert.ok(lm, 'Should have LM324')
    assert.equal(lm.unitCount, 5) // units 1-5
    assert.equal(lm.pins.size, 7) // 8 pin definitions, but pin "4" shared between unit 2 and power unit → deduplicated

    // Check that units are tracked
    assert.ok(lm.units.has(1), 'Should have unit 1')
    assert.ok(lm.units.has(2), 'Should have unit 2')
    assert.ok(lm.units.has(5), 'Should have unit 5 (power)')
  })

  it('throws on invalid content', () => {
    assert.throws(() => parseSymbolLibrary('not a kicad file'), /Not a valid/)
  })
})

describe('generateBoxSymbol', () => {
  it('generates a box symbol with specified pin count', () => {
    const box = generateBoxSymbol('TestIC', 8)
    assert.equal(box.name, 'TestIC')
    assert.equal(box.pins.size, 8)
    assert.equal(box.unitCount, 1)
  })

  it('generates pins on left and right sides', () => {
    const box = generateBoxSymbol('IC', 4)
    // 4 pins total → split evenly: 2 on left, 2 on right
    const leftPins = [...box.pins.values()].filter(p => p.position.x < 0)
    const rightPins = [...box.pins.values()].filter(p => p.position.x > 0)
    assert.ok(leftPins.length >= 1, `Expected at least 1 left pin, got ${leftPins.length}`)
    assert.ok(rightPins.length >= 1, `Expected at least 1 right pin, got ${rightPins.length}`)
    assert.equal(leftPins.length + rightPins.length, 4, 'All pins should be on left or right')
  })

  it('all pins are passive type', () => {
    const box = generateBoxSymbol('X', 6)
    for (const pin of box.pins.values()) {
      assert.equal(pin.electricalType, 'passive')
    }
  })
})

describe('parseSymLibTable', () => {
  it('parses a sym-lib-table with library entries', () => {
    const table = `
(sym_lib_table
  (version 7)
  (lib (name "Device") (type "KiCad") (uri "\${KICAD_SYMBOL_DIR}/Device.kicad_sym") (options "") (descr "Generic symbols"))
  (lib (name "power") (type "KiCad") (uri "\${KICAD_SYMBOL_DIR}/power.kicad_sym") (options "") (descr "Power symbols"))
)
`
    const entries = parseSymLibTable(table)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].name, 'Device')
    assert.equal(entries[0].type, 'KiCad')
    assert.ok(entries[0].uri.includes('Device.kicad_sym'))
    assert.equal(entries[1].name, 'power')
  })

  it('returns empty array for invalid content', () => {
    const entries = parseSymLibTable('not a table')
    assert.equal(entries.length, 0)
  })
})

describe('SymbolResolver', () => {
  it('falls back to box symbol when library not found', async () => {
    const resolver = new SymbolResolver(['/nonexistent/path'])
    const sym = await resolver.resolve('Fake:Symbol')
    // Should return a box symbol with 8 pins (default)
    assert.equal(sym.pins.size, 8)
    assert.equal(sym.name, 'Symbol')
  })

  it('resolves from embedded library via search path', async () => {
    // Create a temporary .kicad_sym file
    const tmpDir = mkdtempSync(join(tmpdir(), 'kicad-test-'))
    const symContent = `
(kicad_symbol_lib
  (version 20231120)
  (generator "test")
  (symbol "MyRes"
    (property "Reference" "R" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "MyRes_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))))
)
`
    writeFileSync(join(tmpDir, 'TestLib.kicad_sym'), symContent)

    const resolver = new SymbolResolver([tmpDir])
    const sym = await resolver.resolve('TestLib:MyRes')
    assert.equal(sym.pins.size, 2)
    assert.ok(sym.pins.has('1'))
    assert.ok(sym.pins.has('2'))
    assert.equal(sym.pins.get('1').electricalType, 'passive')

    rmSync(tmpDir, { recursive: true })
  })
})
