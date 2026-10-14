#!/usr/bin/env node
import '@codekalakaars/vajra-sandbox/platform-guard'
import { mountVirtualFilesystem } from '@codekalakaars/vajra-sandbox'

const [, , projectRoot, mountpoint, configPath, environment] = process.argv
if (!projectRoot || !mountpoint || !configPath) {
  process.stderr.write('Vajra VFS server requires a project, mountpoint, and config path\n')
  process.exit(2)
}

try {
  mountVirtualFilesystem(projectRoot, mountpoint, configPath, environment)
} catch (error) {
  process.stderr.write(`Vajra VFS mount failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
