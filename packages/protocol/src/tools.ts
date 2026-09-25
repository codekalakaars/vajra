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
  schema: z.ZodType<Args, z.ZodTypeDef, unknown>
  jsonSchema: JsonSchema
}

function defineTool<Args>(def: ToolDefinition<Args>): ToolDefinition<Args> {
  return def
}

export const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read a UTF-8 text file and return its contents.',
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

export const searchContentTool = defineTool({
  name: 'search_content',
  description:
    'Search file contents in the project for a literal string (or a regular ' +
    'expression when isRegex is true). Returns up to maxResults matches as ' +
    'path:line: text. Masked files (.env and environment variants) are never ' +
    'searched, so their contents can never appear. Build and dependency ' +
    'directories (dist/, node_modules/, target/, …) are skipped.',
  schema: z.object({
    query: z.string().min(1),
    isRegex: z.boolean().optional(),
    maxResults: z.number().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text (or regular expression) to find in file contents.' },
      isRegex: {
        type: 'boolean',
        description: 'Treat query as a JavaScript regular expression (default: false, literal match).',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of matching lines to return (default 50, capped at 200).',
      },
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
  schema: z.object({
    command: z.string(),
    cwd: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute (space-separated argv).' },
      cwd: { type: 'string', description: 'Working directory (defaults to project root).' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 30000).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
})

export const runBaselineTool = defineTool({
  name: 'run_baseline',
  description:
    'Run a candidate verification command NOW, before any changes, to record ' +
    'whether it currently passes. Required before proposing it as a ' +
    'proves-change check. Argv form, no shell.',
  schema: z.object({
    command: z.string().min(1),
    args: z.preprocess((v) => (v === undefined ? [] : v), z.array(z.string())),
    cwd: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' },
      timeoutMs: { type: 'number' },
    },
    required: ['command', 'args'],
    additionalProperties: false,
  },
})

export const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Write content to a file, creating it if it does not exist.',
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

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description: 'Delete a file. Fails if the path is a directory.',
  schema: z.object({ path: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative or absolute path.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
})

export const createDirTool = defineTool({
  name: 'create_dir',
  description: 'Create a directory, including missing parent directories.',
  schema: z.object({ path: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative or absolute path.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
})

/** A file the worker should read, and the reason it matters. */
export interface ContextRef {
  path: string
  /** Why this file is needed — lets the worker skip what it already knows. */
  reason: string
  /** Optional: narrow a large file to the symbols that matter. */
  symbols?: string[]
}

/** A single change, anchored to text rather than a line number. */
export interface EditSpec {
  path: string
  op: 'create' | 'modify' | 'delete'
  /**
   * Exact, unique text identifying the edit site. Required when op === 'modify'.
   * This is the same contract `editFile` already enforces — it fails on an
   * absent or ambiguous match — so the plan becomes directly executable.
   */
  anchor?: string
  /** Filled in by the harness, not the model: occurrences of `anchor` in the file. */
  anchorOccurrences?: number
  /** Imperative and specific: what to write at that site. */
  change: string
}

/** A command that decides whether the task worked. */
export interface VerifySpec {
  /** Executable only — argv form, no shell. */
  command: string
  args: string[]
  cwd?: string
  expectExit: number
  /** Optional substring that must appear in stdout+stderr. */
  expectStdout?: string
  timeoutSeconds: number
  /**
   * 'proves-change'  — must FAIL before the edit, pass after. This is the test.
   * 'regression-guard' — must PASS before and after. This is the safety net.
   */
  kind: 'proves-change' | 'regression-guard'
  /** Filled in by the harness: exit code observed when run at plan time. */
  baselineExit?: number
}

/** A decision two tasks must agree on that no single file shows. */
export interface PlanContract {
  id: string
  /** The decision, stated so an implementer can follow it with no other context. */
  statement: string
  /** Task that establishes it. */
  producedBy: string
  /** Tasks that must code against it. */
  consumedBy: string[]
}

export interface PlannedTaskInput {
  /** Stable task id. Other tasks reference it from dependsOn. */
  id: string
  title: string
  description: string

  /** Structured form. When present, supersedes readFile/writeFile/instructions/validation. */
  context?: ContextRef[]
  edits?: EditSpec[]
  verify?: VerifySpec[]

  /** Step-by-step instructions — exactly what the worker should do. */
  instructions?: string[]
  /** Files to read (read-only access). */
  readFile?: string[]
  /** Files to write/edit (read-write access). */
  writeFile?: string[]
  /** Files to delete. */
  deleteFile?: string[]
  /** Directories to create. */
  createDir?: string[]
  /** Validation commands to run after completion (string or list). */
  validation?: string | string[]
  /** Task IDs this depends on. */
  dependsOn?: string[]
  /** Task type. Defaults to 'modify'. */
  type?: 'create' | 'modify' | 'delete' | 'refactor'
  /** Tools this worker can use. Omit for task-type defaults. */
  allowedTools?: string[]
  /** Timeout in seconds for this task. Default: 120. */
  timeoutSeconds?: number
  /** Max retries for this task. Default: 2. Set to 0 for no retries. */
  retries?: number
  /** Rollback instructions if validation fails (e.g. "git checkout src/file.ts"). */
  rollback?: string[]
  /** Condition to skip this task (e.g. "file exists: src/config.json" or "command passes: npm test"). */
  skipIf?: string[]
}

export interface ProposePlanArgs {
  tasks: PlannedTaskInput[]
  contracts?: PlanContract[]
  summary: string
}

const stringArray = z.preprocess(
  (value) => (value === undefined ? [] : value),
  z.array(z.string()),
)

const validationArray = z.preprocess(
  (value) => {
    if (value === undefined) return []
    if (typeof value === 'string') return [value]
    return value
  },
  z.array(z.string()),
)

const contextRefSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  symbols: z.array(z.string()).optional(),
})

const editSpecSchema = z.object({
  path: z.string().min(1),
  op: z.enum(['create', 'modify', 'delete']),
  anchor: z.string().optional(),
  anchorOccurrences: z.number().optional(),
  change: z.string().min(1),
})

const verifySpecSchema = z.object({
  command: z.string().min(1),
  args: z.preprocess((v) => (v === undefined ? [] : v), z.array(z.string())),
  cwd: z.string().optional(),
  expectExit: z.number().default(0),
  expectStdout: z.string().optional(),
  timeoutSeconds: z.number().default(120),
  kind: z.enum(['proves-change', 'regression-guard']).default('proves-change'),
  baselineExit: z.number().optional(),
})

const planContractSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  producedBy: z.string().min(1),
  consumedBy: z.array(z.string()).min(1),
})

export const proposePlanTool = defineTool<ProposePlanArgs>({
  name: 'propose_plan',
  description:
    'Propose a structured plan for the user\'s task. Call this when you have ' +
    'gathered enough context through conversation. Do NOT call on the first message — ' +
    'gather context first by asking clarifying questions and exploring the codebase. ' +
    'Each task must have EXACT instructions for the worker — no ambiguity.',
  schema: z.object({
    tasks: z.array(z.object({
      id: z.string().min(1),
      title: z.string(),
      description: z.string(),
      context: z.array(contextRefSchema).optional(),
      edits: z.array(editSpecSchema).optional(),
      verify: z.array(verifySpecSchema).optional(),
      instructions: stringArray,
      readFile: stringArray,
      writeFile: stringArray,
      deleteFile: stringArray,
      createDir: stringArray,
      validation: validationArray,
      dependsOn: stringArray,
      type: z.enum(['create', 'modify', 'delete', 'refactor']).default('modify'),
      allowedTools: z.array(z.string()).optional(),
      timeoutSeconds: z.number().optional(),
      retries: z.number().optional(),
      rollback: z.array(z.string()).optional(),
      skipIf: z.array(z.string()).optional(),
    })),
    contracts: z.array(planContractSchema).optional(),
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
            id: {
              type: 'string',
              description: 'Stable unique id for this task (e.g. "auth-middleware"). Other tasks that depend on it must list this id in dependsOn.',
            },
            title: { type: 'string', description: 'Short title for the task.' },
            description: { type: 'string', description: 'What needs to be done and why.' },
            context: {
              type: 'array',
              description:
                'Files the worker must read, each with the reason it matters. ' +
                'Only list files you have actually read yourself.',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  reason: { type: 'string', description: 'Why this file is needed, in one clause.' },
                  symbols: { type: 'array', items: { type: 'string' } },
                },
                required: ['path', 'reason'],
                additionalProperties: false,
              },
            },
            edits: {
              type: 'array',
              description: 'Every change this task makes.',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  op: { type: 'string', enum: ['create', 'modify', 'delete'] },
                  anchor: {
                    type: 'string',
                    description:
                      'REQUIRED for modify. Exact text from the file that appears ' +
                      'EXACTLY ONCE, identifying where the change goes. Copy it ' +
                      'verbatim from the file you read — do not paraphrase.',
                  },
                  change: {
                    type: 'string',
                    description: 'What to write at that site. Imperative and specific.',
                  },
                },
                required: ['path', 'op', 'change'],
                additionalProperties: false,
              },
            },
            verify: {
              type: 'array',
              description:
                'Commands that decide whether this task worked. Argv form, no shell. ' +
                'At least one must be kind=proves-change: a command that FAILS now ' +
                'and passes once the task is done.',
              items: {
                type: 'object',
                properties: {
                  command: { type: 'string', description: 'Executable only, e.g. "pnpm".' },
                  args: { type: 'array', items: { type: 'string' } },
                  cwd: { type: 'string' },
                  expectExit: { type: 'number' },
                  expectStdout: { type: 'string' },
                  timeoutSeconds: { type: 'number' },
                  kind: { type: 'string', enum: ['proves-change', 'regression-guard'] },
                },
                required: ['command', 'args', 'kind'],
                additionalProperties: false,
              },
            },
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
              description: 'Commands to run after completion. Pass if ALL exit 0. A single string is also accepted. Example: ["cargo test", "cargo clippy -- -D warnings"]',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'ids of tasks this depends on (empty if independent).',
            },
            type: { type: 'string', description: 'Task type: create, modify, delete, or refactor. Defaults to modify.' },
            allowedTools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tools this worker can use. Omit for defaults: create/modify get read+write+edit, delete gets read+delete.',
            },
            timeoutSeconds: {
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
          required: ['id', 'title', 'description'],
          additionalProperties: false,
        },
      },
      summary: { type: 'string', description: 'Brief summary of the overall plan.' },
      contracts: {
        type: 'array',
        description:
          'Decisions two or more tasks must agree on that no single file shows — ' +
          'a return shape, a field name, which module owns a table. Add one when ' +
          'tasks with no file overlap would otherwise invent the same interface ' +
          'differently. Write each statement in full: an agent reads it cold.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short identifier for this contract.' },
            statement: {
              type: 'string',
              description:
                'The decision in full, self-contained. Never "as discussed" or ' +
                '"the above" — at least a full sentence naming the shape/owner.',
            },
            producedBy: { type: 'string', description: 'Task id that establishes the contract.' },
            consumedBy: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task ids that must code against it. Must depend on producedBy.',
            },
          },
          required: ['id', 'statement', 'producedBy', 'consumedBy'],
          additionalProperties: false,
        },
      },
    },
    required: ['tasks', 'summary'],
    additionalProperties: false,
  },
})

export const toolDefinitions = {
  read_file: readFileTool,
  list_files: listFilesTool,
  search_files: searchFilesTool,
  search_content: searchContentTool,
  run_command: runCommandTool,
  run_baseline: runBaselineTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  delete_file: deleteFileTool,
  create_dir: createDirTool,
  propose_plan: proposePlanTool,
} as const satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof toolDefinitions

/**
 * Canonical role → tool table (contract C2). The sandbox's ROLE_DEFAULTS
 * is deleted in favour of this map — do not reintroduce a rival table.
 */
export const roleTools: Record<string, ToolName[]> = {
  developer: ['read_file', 'list_files', 'search_files', 'search_content', 'run_baseline', 'propose_plan'],
  master: ['read_file', 'list_files', 'search_files', 'run_command'],
  worker: [
    'read_file',
    'list_files',
    'search_files',
    'search_content',
    'write_file',
    'edit_file',
    'delete_file',
    'create_dir',
    'run_command',
  ],
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
