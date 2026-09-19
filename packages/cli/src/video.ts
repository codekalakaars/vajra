import { Command } from 'commander'
import { execFileSync } from 'node:child_process'

const REGISTRY_BASE =
  'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry'

const VALID_TYPES = ['example', 'block', 'component']
const VALID_QUALITIES = ['draft', 'standard', 'high']
const VALID_FORMATS = ['mp4', 'webm', 'mov', 'gif']

interface RegistryItem {
  name: string
  type: 'hyperframes:block' | 'hyperframes:component' | 'hyperframes:example'
}

async function fetchRegistry(): Promise<RegistryItem[]> {
  const response = await fetch(`${REGISTRY_BASE}/registry.json`)
  const data = (await response.json()) as { items: RegistryItem[] }
  return data.items
}

function handleError(label: string, error: unknown): never {
  if (error instanceof Error) {
    const msg = error.message
    if (msg.includes('ENOENT')) {
      console.error(`\x1b[31m✗ ${label}: npx not found. Install Node.js first.\x1b[0m`)
    } else if (msg.includes('npm ERR')) {
      console.error(`\x1b[31m✗ ${label}: Package installation failed. Check your network connection.\x1b[0m`)
    } else {
      console.error(`\x1b[31m✗ ${label}: ${msg}\x1b[0m`)
    }
  } else {
    console.error(`\x1b[31m✗ ${label}: ${String(error)}\x1b[0m`)
  }
  process.exit(1)
}

export const videoCommand = new Command('video')
  .description('Create and manage HyperFrames videos')
  .addHelpText('after', `
Examples:
  $ vajra video init my-video
  $ vajra video init my-video --template blank --resolution portrait
  $ vajra video add cinematic-title
  $ vajra video list --type block
  $ vajra video render
  $ vajra video preview`)

videoCommand
  .command('init')
  .description('Initialize a new video project from a template')
  .argument('<name>', 'Project name')
  .option('-t, --template <template>', 'Template to use (blank, cinematic, etc.)', 'blank')
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

      execFileSync('npx', args.slice(1), { stdio: 'inherit' })
      console.log(`\n\x1b[32m✓ Project "${name}" initialized successfully!\x1b[0m`)
      console.log(`\nNext steps:`)
      console.log(`  cd ${name}`)
      console.log(`  npx hyperframes preview`)
    } catch (error) {
      handleError(`Failed to initialize "${name}"`, error)
    }
  })

videoCommand
  .command('add')
  .description('Add a registry block to the current project')
  .argument('<block>', 'Block name to add')
  .option('-d, --dir <directory>', 'Project directory', '.')
  .addHelpText('after', `
Run 'vajra video list' to see available blocks.`)
  .action(async (block, options) => {
    console.log(`Adding block "${block}"...`)

    try {
      execFileSync('npx', ['hyperframes', 'add', block, '--dir', options.dir, '--no-clipboard'], {
        stdio: 'inherit',
      })
      console.log(`\n\x1b[32m✓ Block "${block}" added successfully!\x1b[0m`)
    } catch (error) {
      handleError(`Failed to add block "${block}"`, error)
    }
  })

videoCommand
  .command('list')
  .description('List available templates, blocks, and components')
  .option('-t, --type <type>', 'Filter by type (example, block, component)')
  .action(async (options) => {
    if (options.type && !VALID_TYPES.includes(options.type)) {
      console.error(`\x1b[31m✗ Invalid type '${options.type}'. Valid types: ${VALID_TYPES.join(', ')}\x1b[0m`)
      process.exit(1)
    }

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
      handleError('Failed to fetch registry', error)
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
  .addHelpText('after', `
Quality options:
  draft    - Fast, lower quality
  standard - Balanced (default)
  high     - Best quality, slower

Format options:
  mp4, webm, mov, gif`)
  .action((dir, options) => {
    if (!VALID_QUALITIES.includes(options.quality)) {
      console.error(`\x1b[31m✗ Invalid quality '${options.quality}'. Valid options: ${VALID_QUALITIES.join(', ')}\x1b[0m`)
      process.exit(1)
    }
    if (!VALID_FORMATS.includes(options.format)) {
      console.error(`\x1b[31m✗ Invalid format '${options.format}'. Valid options: ${VALID_FORMATS.join(', ')}\x1b[0m`)
      process.exit(1)
    }

    console.log('Rendering video...\n')

    const args = ['npx', 'hyperframes', 'render', dir]

    if (options.output) args.push('--output', options.output)
    if (options.quality) args.push('--quality', options.quality)
    if (options.format) args.push('--format', options.format)
    if (options.fps) args.push('--fps', options.fps)
    if (options.strict) args.push('--strict')

    try {
      execFileSync('npx', args.slice(1), { stdio: 'inherit' })
      console.log('\n\x1b[32m✓ Render complete!\x1b[0m')
    } catch (error) {
      handleError('Render failed', error)
    }
  })

videoCommand
  .command('preview')
  .description('Preview the current project in Studio')
  .argument('[dir]', 'Project directory', '.')
  .option('-p, --port <port>', 'Port number', '3002')
  .addHelpText('after', `
Opens a local dev server to preview your video in the browser.`)
  .action((dir, options) => {
    console.log('Starting preview server...\n')

    try {
      execFileSync('npx', ['hyperframes', 'preview', dir, '--port', options.port], {
        stdio: 'inherit',
      })
    } catch (error) {
      handleError('Preview failed', error)
    }
  })
