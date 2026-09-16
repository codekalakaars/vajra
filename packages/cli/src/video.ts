import { Command } from 'commander'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REGISTRY_BASE =
  'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry'

interface RegistryItem {
  name: string
  type: 'hyperframes:block' | 'hyperframes:component' | 'hyperframes:example'
}

async function fetchRegistry(): Promise<RegistryItem[]> {
  const response = await fetch(`${REGISTRY_BASE}/registry.json`)
  const data = (await response.json()) as { items: RegistryItem[] }
  return data.items
}

export const videoCommand = new Command('video')
  .description('Create and manage HyperFrames videos')

videoCommand
  .command('init')
  .description('Initialize a new video project from a template')
  .argument('<name>', 'Project name')
  .option('-t, --template <template>', 'Template to use', 'blank')
  .option('-r, --resolution <resolution>', 'Resolution (landscape, portrait, square)', 'landscape')
  .option('--tailwind', 'Use Tailwind CSS')
  .action(async (name, options) => {
    console.log(`Initializing video project "${name}" from template "${options.template}"...`)
    
    try {
      const args = [
        'npx', 'hyperframes', 'init', name,
        '--example', options.template,
        '--non-interactive',
        '--resolution', options.resolution,
      ]
      
      if (options.tailwind) {
        args.push('--tailwind')
      }
      
      execSync(args.join(' '), { stdio: 'inherit' })
      console.log(`\nProject "${name}" initialized successfully!`)
      console.log(`\nNext steps:`)
      console.log(`  cd ${name}`)
      console.log(`  npx hyperframes preview`)
    } catch (error) {
      console.error('Failed to initialize project:', error)
      process.exit(1)
    }
  })

videoCommand
  .command('add')
  .description('Add a registry block to the current project')
  .argument('<block>', 'Block name')
  .option('-d, --dir <directory>', 'Project directory', '.')
  .action(async (block, options) => {
    console.log(`Adding block "${block}"...`)
    
    try {
      execSync(`npx hyperframes add ${block} --dir ${options.dir} --no-clipboard`, {
        stdio: 'inherit',
      })
      console.log(`\nBlock "${block}" added successfully!`)
    } catch (error) {
      console.error('Failed to add block:', error)
      process.exit(1)
    }
  })

videoCommand
  .command('list')
  .description('List available templates, blocks, and components')
  .option('-t, --type <type>', 'Filter by type (example, block, component)')
  .action(async (options) => {
    console.log('Fetching registry...\n')
    
    try {
      const items = await fetchRegistry()
      
      const filtered = options.type
        ? items.filter(i => i.type === `hyperframes:${options.type}`)
        : items
      
      const examples = filtered.filter(i => i.type === 'hyperframes:example')
      const blocks = filtered.filter(i => i.type === 'hyperframes:block')
      const components = filtered.filter(i => i.type === 'hyperframes:component')
      
      if (examples.length > 0) {
        console.log('\x1b[1mTemplates (examples):\x1b[0m')
        for (const item of examples) {
          console.log(`  - ${item.name}`)
        }
        console.log('')
      }
      
      if (blocks.length > 0) {
        console.log('\x1b[1mBlocks:\x1b[0m')
        for (const item of blocks) {
          console.log(`  - ${item.name}`)
        }
        console.log('')
      }
      
      if (components.length > 0) {
        console.log('\x1b[1mComponents:\x1b[0m')
        for (const item of components) {
          console.log(`  - ${item.name}`)
        }
        console.log('')
      }
      
      console.log(`Total: ${filtered.length} items`)
    } catch (error) {
      console.error('Failed to fetch registry:', error)
      process.exit(1)
    }
  })

videoCommand
  .command('render')
  .description('Render the current project to MP4')
  .argument('[dir]', 'Project directory', '.')
  .option('-o, --output <path>', 'Output file path')
  .option('-q, --quality <quality>', 'Quality (draft, standard, high)', 'standard')
  .option('-f, --format <format>', 'Format (mp4, webm, mov, gif)', 'mp4')
  .option('--fps <fps>', 'Frame rate', '30')
  .option('--strict', 'Fail on lint errors')
  .action((dir, options) => {
    console.log('Rendering video...\n')
    
    const args = ['npx', 'hyperframes', 'render', dir]
    
    if (options.output) args.push('--output', options.output)
    if (options.quality) args.push('--quality', options.quality)
    if (options.format) args.push('--format', options.format)
    if (options.fps) args.push('--fps', options.fps)
    if (options.strict) args.push('--strict')
    
    try {
      execSync(args.join(' '), { stdio: 'inherit' })
      console.log('\nRender complete!')
    } catch (error) {
      console.error('Render failed:', error)
      process.exit(1)
    }
  })

videoCommand
  .command('preview')
  .description('Preview the current project in Studio')
  .argument('[dir]', 'Project directory', '.')
  .option('-p, --port <port>', 'Port number', '3002')
  .action((dir, options) => {
    console.log('Starting preview server...\n')
    
    try {
      execSync(`npx hyperframes preview ${dir} --port ${options.port}`, {
        stdio: 'inherit',
      })
    } catch (error) {
      console.error('Preview failed:', error)
      process.exit(1)
    }
  })
