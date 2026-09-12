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
  enum?: (string | number)[]
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

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description: 'Delete a file or empty directory.',
  nativeFn: 'deleteFile',
  schema: z.object({
    path: z.string(),
    recursive: z.boolean().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative or absolute path.' },
      recursive: { type: 'boolean', description: 'Delete directories recursively (default: false).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
})

export interface PlannedTaskInput {
  title: string
  description: string
  files: string[]
  validation: string
  dependsOn: string[]
  type: 'create' | 'modify' | 'delete' | 'refactor'
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
    'gather context first by asking clarifying questions and exploring the codebase.',
  nativeFn: '',
  schema: z.object({
    tasks: z.array(z.object({
      title: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      validation: z.string(),
      dependsOn: z.array(z.string()),
      type: z.enum(['create', 'modify', 'delete', 'refactor']),
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
            description: { type: 'string', description: 'What needs to be done.' },
            files: { type: 'array', items: { type: 'string' }, description: 'Project-relative file paths this task touches.' },
            validation: { type: 'string', description: 'Command to verify task completion (e.g. "cargo test", "npm test").' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task indices this depends on (empty if independent).' },
            type: { type: 'string', description: 'Task type: create, modify, delete, or refactor.' },
          },
          required: ['title', 'description', 'files', 'validation', 'dependsOn', 'type'],
          additionalProperties: false,
        },
      },
      summary: { type: 'string', description: 'Brief summary of the overall plan.' },
    },
    required: ['tasks', 'summary'],
    additionalProperties: false,
  },
})

export interface CircuitComponent {
  reference: string
  value: string
  footprint: string
  symbol: string
}

export interface CircuitNet {
  name: string
  connections: Array<{ reference: string; pin: string }>
}

export interface TextToSchematicArgs {
  components: CircuitComponent[]
  nets: CircuitNet[]
}

export const textToSchematicTool = defineTool<TextToSchematicArgs>({
  name: 'text_to_schematic',
  description:
    'Convert a structured circuit description into a schematic and PCB layout. ' +
    'Define components (reference, value, footprint, symbol) and nets (connections between component pins). ' +
    'Generates .kicad_sch and .kicad_pcb files in the project directory.',
  nativeFn: 'textToSchematic',
  schema: z.object({
    components: z.array(z.object({
      reference: z.string().describe('Component reference designator (e.g., R1, C1, U1)'),
      value: z.string().describe('Component value (e.g., 10k, 100nF, LM7805)'),
      footprint: z.string().describe('KiCad footprint (e.g., Resistor_SMD:R_0402_1005Metric)'),
      symbol: z.string().describe('KiCad symbol library ID (e.g., Device:R, Package_TO_SOT_SMD:SOT-223-3_TabPin2)'),
    })),
    nets: z.array(z.object({
      name: z.string().describe('Net name (e.g., VCC, GND, SIG)'),
      connections: z.array(z.object({
        reference: z.string().describe('Component reference'),
        pin: z.string().describe('Pin name or number'),
      })),
    })),
    boardConstraints: z.object({
      width: z.number().optional().describe('Board width in mm'),
      height: z.number().optional().describe('Board height in mm'),
      layers: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional().describe('Number of copper layers (1, 2, or 4)'),
      designRules: z.object({
        traceWidth: z.number().optional().describe('Minimum trace width in mm'),
        clearance: z.number().optional().describe('Minimum clearance in mm'),
        viaSize: z.number().optional().describe('Via outer diameter in mm'),
        viaDrill: z.number().optional().describe('Via drill diameter in mm'),
      }).optional().describe('Design rules for PCB generation'),
    }).optional().describe('Optional board constraints for PCB generation'),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      components: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            reference: { type: 'string', description: 'Component reference designator (e.g., R1, C1, U1)' },
            value: { type: 'string', description: 'Component value (e.g., 10k, 100nF, LM7805)' },
            footprint: { type: 'string', description: 'KiCad footprint (e.g., Resistor_SMD:R_0402_1005Metric)' },
            symbol: { type: 'string', description: 'KiCad symbol library ID (e.g., Device:R, Package_TO_SOT_SMD:SOT-223-3_Pin2)' },
          },
          required: ['reference', 'value', 'footprint', 'symbol'],
          additionalProperties: false,
        },
        description: 'List of electronic components in the circuit.',
      },
      nets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Net name (e.g., VCC, GND, SIG)' },
            connections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  reference: { type: 'string', description: 'Component reference designator' },
                  pin: { type: 'string', description: 'Pin name or number' },
                },
                required: ['reference', 'pin'],
                additionalProperties: false,
              },
              description: 'Component pins connected to this net.',
            },
          },
          required: ['name', 'connections'],
          additionalProperties: false,
        },
        description: 'List of electrical nets connecting component pins.',
      },
      boardConstraints: {
        type: 'object',
        properties: {
          width: { type: 'number', description: 'Board width in mm' },
          height: { type: 'number', description: 'Board height in mm' },
          layers: { type: 'number', enum: [1, 2, 4], description: 'Number of copper layers (1, 2, or 4)' },
          designRules: {
            type: 'object',
            properties: {
              traceWidth: { type: 'number', description: 'Minimum trace width in mm' },
              clearance: { type: 'number', description: 'Minimum clearance in mm' },
              viaSize: { type: 'number', description: 'Via outer diameter in mm' },
              viaDrill: { type: 'number', description: 'Via drill diameter in mm' },
            },
            additionalProperties: false,
            description: 'Design rules for PCB generation.',
          },
        },
        additionalProperties: false,
        description: 'Optional board constraints for PCB generation.',
      },
    },
    required: ['components', 'nets'],
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
  delete_file: deleteFileTool,
  propose_plan: proposePlanTool,
  text_to_schematic: textToSchematicTool,
} as const satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof toolDefinitions

export const roleTools: Record<string, ToolName[]> = {
  manager: ['read_file', 'list_files', 'search_files', 'propose_plan'],
  master: ['read_file', 'list_files', 'search_files', 'run_command', 'text_to_schematic'],
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
