import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSchematicFromDescription, validateCircuitDescription } from '../dist/circuit-builder.js'

describe('buildSchematicFromDescription', () => {
  it('builds a simple voltage divider', () => {
    const description = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402_1005Metric', symbol: 'Device:R' },
        { reference: 'R2', value: '10k', footprint: 'Resistor_SMD:R_0402_1005Metric', symbol: 'Device:R' },
      ],
      nets: [
        { name: 'VIN', connections: [{ reference: 'R1', pin: '1' }] },
        { name: 'VOUT', connections: [{ reference: 'R1', pin: '2' }, { reference: 'R2', pin: '1' }] },
        { name: 'GND', connections: [{ reference: 'R2', pin: '2' }] },
      ],
    }

    const result = buildSchematicFromDescription(description)

    assert.equal(result.componentCount, 2)
    assert.equal(result.netCount, 3)

    const r1 = result.components.find(c => c.reference === 'R1')
    assert.ok(r1)
    assert.equal(r1.value, '10k')
    assert.deepEqual(r1.connections, { VIN: '1', VOUT: '2' })

    const r2 = result.components.find(c => c.reference === 'R2')
    assert.ok(r2)
    assert.deepEqual(r2.connections, { VOUT: '1', GND: '2' })

    const vout = result.nets.find(n => n.name === 'VOUT')
    assert.ok(vout)
    assert.deepEqual(vout.components, ['R1', 'R2'])
  })

  it('builds a power supply circuit', () => {
    const description = {
      components: [
        { reference: 'U1', value: 'LM7805', footprint: 'Package_TO_SOT_SMD:TO-220-3_TabPin2', symbol: 'Regulator_Linear:LM7805' },
        { reference: 'C1', value: '100nF', footprint: 'Capacitor_SMD:C_0402_1005Metric', symbol: 'Device:C' },
        { reference: 'C2', value: '100nF', footprint: 'Capacitor_SMD:C_0402_1005Metric', symbol: 'Device:C' },
      ],
      nets: [
        { name: 'VIN', connections: [{ reference: 'U1', pin: '1' }, { reference: 'C1', pin: '1' }] },
        { name: 'GND', connections: [{ reference: 'U1', pin: '2' }, { reference: 'C1', pin: '2' }, { reference: 'C2', pin: '2' }] },
        { name: 'VOUT', connections: [{ reference: 'U1', pin: '3' }, { reference: 'C2', pin: '1' }] },
      ],
    }

    const result = buildSchematicFromDescription(description)

    assert.equal(result.componentCount, 3)
    assert.equal(result.netCount, 3)

    const u1 = result.components.find(c => c.reference === 'U1')
    assert.ok(u1)
    assert.equal(u1.value, 'LM7805')
    assert.deepEqual(u1.connections, { VIN: '1', GND: '2', VOUT: '3' })
  })
})

describe('validateCircuitDescription', () => {
  it('returns no errors for valid description', () => {
    const description = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R' },
      ],
      nets: [
        { name: 'SIG', connections: [{ reference: 'R1', pin: '1' }, { reference: 'R1', pin: '2' }] },
      ],
    }

    const errors = validateCircuitDescription(description)
    assert.equal(errors.length, 0)
  })

  it('detects duplicate references', () => {
    const description = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R' },
        { reference: 'R1', value: '20k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R' },
      ],
      nets: [],
    }

    const errors = validateCircuitDescription(description)
    assert.ok(errors.some(e => e.includes('Duplicate reference')))
  })

  it('detects nets with fewer than 2 connections', () => {
    const description = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R' },
      ],
      nets: [
        { name: 'SIG', connections: [{ reference: 'R1', pin: '1' }] },
      ],
    }

    const errors = validateCircuitDescription(description)
    assert.ok(errors.some(e => e.includes('fewer than 2 connections')))
  })

  it('detects unknown component references in nets', () => {
    const description = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', symbol: 'Device:R' },
      ],
      nets: [
        { name: 'SIG', connections: [{ reference: 'R1', pin: '1' }, { reference: 'R2', pin: '1' }] },
      ],
    }

    const errors = validateCircuitDescription(description)
    assert.ok(errors.some(e => e.includes('unknown component')))
  })
})
