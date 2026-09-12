// Tool schema the agent's model sees, and what each tool dispatches to.
// run_shell is deliberately not offered — run_command (argv-based, no shell)
// covers file-editing tasks without the shell-injection surface.
// This package does not import vajra-core — browser bundles can't load .node.

import { z } from 'zod'

interface JsonSchemaProperty {
  type: string
  description?: string
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
  enum?: string[]
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties: false
}

export interface ToolDefinition<Args = unknown> {
  name: string
  description: string
  nativeFn: string
  schema: z.ZodType<Args>
  jsonSchema: JsonSchema
}

function defineTool<Args>(def: ToolDefinition<Args>): ToolDefinition<Args> {
  return def
}

export const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read a UTF-8 text file and return its contents.',
  nativeFn: 'readFile',
  schema: z.object({ path: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Project-relative or absolute path.' } },
    required: ['path'],
    additionalProperties: false,
  },
})

export const listFilesTool = defineTool({
  name: 'list_files',
  description: 'List directory contents, optionally recursively.',
  nativeFn: 'listFiles',
  schema: z.object({ path: z.string(), recursive: z.boolean().optional() }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean' },
    },
    required: ['path'],
    additionalProperties: false,
  },
})

export const searchFilesTool = defineTool({
  name: 'search_files',
  description:
    'Search the project summary index for files matching a query. ' +
    'Returns file paths, their exported symbols, and a brief preview. ' +
    'Use this to find relevant files before reading them.',
  nativeFn: 'searchSummary',
  schema: z.object({ query: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms to match against file paths and symbols.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
})

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    'Execute a command (argv-based, no shell parsing). Returns stdout and stderr. ' +
    'Use this for running tests, linters, build commands, or any validation.',
  nativeFn: 'runCommand',
  schema: z.object({
    command: z.string(),
    cwd: z.string().optional(),
    timeout: z.number().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute (space-separated argv).' },
      cwd: { type: 'string', description: 'Working directory (defaults to project root).' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
})

export const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Write content to a file, creating it if it does not exist.',
  nativeFn: 'writeFile',
  schema: z.object({ path: z.string(), content: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative or absolute path.' },
      content: { type: 'string', description: 'File contents to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
})

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace old_string with new_string in a file. Fails on absent or ambiguous match.',
  nativeFn: 'editFile',
  schema: z.object({
    path: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldString: { type: 'string', description: 'Exact text to find and replace.' },
      newString: { type: 'string', description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace all occurrences (default: false).' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
})

export interface PlannedTaskInput {
  title: string
  description: string
  /** Step-by-step instructions — exactly what the worker should do. */
  instructions: string[]
  /** Files to read (read-only access). */
  readFile: string[]
  /** Files to write/edit (read-write access). */
  writeFile: string[]
  /** Files to delete. */
  deleteFile: string[]
  /** Directories to create. */
  createDir: string[]
  /** Validation commands to run after completion. */
  validation: string[]
  /** Task IDs this depends on. */
  dependsOn: string[]
  /** Task type. */
  type: 'create' | 'modify' | 'delete' | 'refactor'
  /** Tools this worker can use. Omit for task-type defaults. */
  allowedTools?: string[]
  /** Timeout in seconds for this task. Default: 120. */
  timeout?: number
  /** Max retries for this task. Default: 2. Set to 0 for no retries. */
  retries?: number
  /** Rollback instructions if validation fails (e.g. "git checkout src/file.ts"). */
  rollback?: string[]
  /** Condition to skip this task (e.g. "file exists: src/config.json" or "command passes: npm test"). */
  skipIf?: string[]
}

export interface ProposePlanArgs {
  tasks: PlannedTaskInput[]
  summary: string
}

export const proposePlanTool = defineTool<ProposePlanArgs>({
  name: 'propose_plan',
  description:
    'Propose a structured plan for the user\'s task. Call this when you have ' +
    'gathered enough context through conversation. Do NOT call on the first message — ' +
    'gather context first by asking clarifying questions and exploring the codebase. ' +
    'Each task must have EXACT instructions for the worker — no ambiguity.',
  nativeFn: '',
  schema: z.object({
    tasks: z.array(z.object({
      title: z.string(),
      description: z.string(),
      instructions: z.array(z.string()),
      readFile: z.array(z.string()),
      writeFile: z.array(z.string()),
      deleteFile: z.array(z.string()),
      createDir: z.array(z.string()),
      validation: z.array(z.string()),
      dependsOn: z.array(z.string()),
      type: z.enum(['create', 'modify', 'delete', 'refactor']),
      allowedTools: z.array(z.string()).optional(),
      timeout: z.number().optional(),
      retries: z.number().optional(),
      rollback: z.array(z.string()).optional(),
      skipIf: z.array(z.string()).optional(),
    })),
    summary: z.string(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title for the task.' },
            description: { type: 'string', description: 'What needs to be done and why.' },
            instructions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Step-by-step instructions. Each step should be a single action. Example: ["In src/api.ts, add a try-catch around the db.query() call on line 42", "Return a 500 status with { error: e.message } in the catch block"]',
            },
            readFile: {
              type: 'array',
              items: { type: 'string' },
              description: 'Files the worker needs to read (read-only). Include files needed for context.',
            },
            writeFile: {
              type: 'array',
              items: { type: 'string' },
              description: 'Files the worker will create or modify (read-write).',
            },
            deleteFile: {
              type: 'array',
              items: { type: 'string' },
              description: 'Files to delete.',
            },
            createDir: {
              type: 'array',
              items: { type: 'string' },
              description: 'Directories to create.',
            },
            validation: {
              type: 'array',
              items: { type: 'string' },
              description: 'Commands to run after completion. Pass if ALL exit 0. Example: ["cargo test", "cargo clippy -- -D warnings"]',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs this depends on (empty if independent).',
            },
            type: { type: 'string', description: 'Task type: create, modify, delete, or refactor.' },
            allowedTools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tools this worker can use. Omit for defaults: create/modify get read+write+edit, delete gets read+delete.',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in seconds for this task. Default: 120. Use longer timeouts for slow builds.',
            },
            retries: {
              type: 'number',
              description: 'Max retries for this task. Default: 2. Set to 0 for no retries.',
            },
            rollback: {
              type: 'array',
              items: { type: 'string' },
              description: 'Rollback instructions if validation fails. Example: ["git checkout src/file.ts"].',
            },
            skipIf: {
              type: 'array',
              items: { type: 'string' },
              description: 'Conditions to skip this task. Example: ["file exists: src/config.json", "command passes: npm test"].',
            },
          },
          required: ['title', 'description', 'instructions', 'readFile', 'writeFile', 'deleteFile', 'createDir', 'validation', 'dependsOn', 'type'],
          additionalProperties: false,
        },
      },
      summary: { type: 'string', description: 'Brief summary of the overall plan.' },
    },
    required: ['tasks', 'summary'],
    additionalProperties: false,
  },
})

export const toolDefinitions = {
  read_file: readFileTool,
  list_files: listFilesTool,
  search_files: searchFilesTool,
  run_command: runCommandTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  propose_plan: proposePlanTool,
} as const satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof toolDefinitions

export const roleTools: Record<string, ToolName[]> = {
  manager: ['read_file', 'list_files', 'search_files', 'propose_plan'],
  master: ['read_file', 'list_files', 'search_files', 'run_command'],
  worker: ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'],
}

export function toOpenAiToolSpecs(tools?: ToolName[]) {
  const defs = tools
    ? tools.map((name) => toolDefinitions[name]).filter(Boolean)
    : Object.values(toolDefinitions)
  return defs.map((def) => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.jsonSchema,
    },
  }))
}

export function toAnthropicToolSpecs(tools?: ToolName[]) {
  const defs = tools
    ? tools.map((name) => toolDefinitions[name]).filter(Boolean)
    : Object.values(toolDefinitions)
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: def.jsonSchema,
  }))
}

/** Provider-agnostic tool spec conversion. */
export function toToolSpecs(provider: 'openai' | 'anthropic', tools?: ToolName[]) {
  return provider === 'anthropic' ? toAnthropicToolSpecs(tools) : toOpenAiToolSpecs(tools)
}
