import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runPipeline } from '../dist/pipeline.js'

describe('runPipeline', () => {
  let tempDir

  it('generates .kicad_sch and .kicad_pcb files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pipeline-test-'))

    const description = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402_1005Metric', symbol: 'Device:R' },
        { reference: 'R2', value: '10k', footprint: 'Resistor_SMD:R_0402_1005Metric', symbol: 'Device:R' },
      ],
      nets: [
        { name: 'VIN', connections: [{ reference: 'R1', pin: '1' }, { reference: 'R2', pin: '1' }] },
        { name: 'GND', connections: [{ reference: 'R1', pin: '2' }, { reference: 'R2', pin: '2' }] },
      ],
    }

    try {
      const result = await runPipeline(description, tempDir)

      // Check result metadata
      assert.equal(result.componentCount, 2)
      assert.equal(result.netCount, 2)
      assert.ok(result.connectionCount >= 2)

      // Check files were written
      const schContent = readFileSync(result.schPath, 'utf-8')
      const pcbContent = readFileSync(result.pcbPath, 'utf-8')

      assert.ok(schContent.includes('kicad_sch'), 'Schematic should contain kicad_sch header')
      assert.ok(pcbContent.includes('kicad_pcb'), 'PCB should contain kicad_pcb header')
      assert.ok(schContent.includes('R1'), 'Schematic should contain R1')
      assert.ok(schContent.includes('R2'), 'Schematic should contain R2')
      assert.ok(pcbContent.includes('R1'), 'PCB should contain R1')
      assert.ok(pcbContent.includes('R2'), 'PCB should contain R2')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid circuit descriptions', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pipeline-test-invalid-'))

    const description = {
      components: [],
      nets: [],
    }

    try {
      await assert.rejects(
        () => runPipeline(description, tempDir),
        /Circuit must have at least one component/,
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('applies board constraints', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pipeline-test-constraints-'))

    const description = {
      components: [
        { reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402_1005Metric', symbol: 'Device:R' },
      ],
      nets: [
        { name: 'SIG', connections: [{ reference: 'R1', pin: '1' }, { reference: 'R1', pin: '2' }] },
      ],
    }

    const constraints = {
      width: 50,
      height: 30,
      layers: 2,
    }

    try {
      const result = await runPipeline(description, tempDir, constraints)

      const pcbContent = readFileSync(result.pcbPath, 'utf-8')
      assert.ok(pcbContent.includes('50'), 'PCB should contain width')
      assert.ok(pcbContent.includes('30'), 'PCB should contain height')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
