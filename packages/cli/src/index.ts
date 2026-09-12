#!/usr/bin/env node

import { Command } from 'commander'
import * as dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './run.js'

// Find root .env file (go up from dist/ to packages/cli, then to repo root)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '..', '..', '..')

// Load .env from root directory
dotenv.config({ path: resolve(rootDir, '.env') })

// Also load from current working directory if different
dotenv.config()

const program = new Command()

program
  .name('vajra')
  .description('Vajra CLI - Multi-agent task execution from the terminal')
  .version('0.1.0')

program
  .command('run')
  .description('Start an interactive session with the manager agent')
  .argument('[task]', 'Initial task description (optional)')
  .option('-k, --api-key <key>', 'OpenRouter API key')
  .option('-m, --model <model>', 'LLM model to use', 'anthropic/claude-3.5-sonnet')
  .option('-v, --verbose', 'Show thinking/reasoning output')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (task, options) => {
    await runCommand({
      task,
      apiKey: options.apiKey || process.env.OPENROUTER_API_KEY,
      model: options.model,
      verbose: options.verbose,
      projectDir: options.dir,
    })
  })

program.parse()
