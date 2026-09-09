// The tool schema the agent's model sees, and what each tool dispatches to.
//
// Thin, literal wrappers over vajra-native — no new capability beyond what it
// already exposes and has tested. Every tool error the model receives is
// exactly the message vajra-native produced (editFile's ambiguous-match
// refusal, deleteFile/deleteDir's directory guards, copyFile/renameFile's
// overwrite guard) — no re-wording layer here, so the tests that already
// assert those messages in the root package stay the single source of truth.
//
// run_shell is deliberately not offered: its own doc comment in
// src/process.rs warns that anything built from untrusted input is a risk,
// and here the "untrusted input" is whatever the model puts in a command
// string. run_command (argv-based, no shell parsing) covers file-editing
// tasks without that surface; add run_shell later only if a real task needs
// pipes/globs the sandbox alone won't gate.
//
// This package does not import `vajra-native` itself — the browser can't
// load a `.node` addon, and importing the type here would pull the loader
// into any bundle that includes this package. Shapes are mirrored by hand.

import { z } from 'zod'

/** A JSON Schema object, loosely typed — only as much shape as building an
 * OpenAI-style tool `parameters` field requires. */
interface JsonSchemaProperty {
  type: string
  description?: string
  /** Present when `type` is `'array'`. */
  items?: { type: string }
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
  /** The vajra-native export this tool dispatches to. */
  nativeFn: string
  /** Runtime validation of the model's tool-call arguments before dispatch. */
  schema: z.ZodType<Args>
  /** What goes in the OpenAI-style `tools[].function.parameters` field. */
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

export const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Write content to a file, overwriting it if it already exists.',
  nativeFn: 'writeFile',
  schema: z.object({ path: z.string(), content: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
})

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace oldString with newString in a file. Fails if oldString is absent, ' +
    'or occurs more than once unless replaceAll is set — an ambiguous match is ' +
    'refused rather than guessed at.',
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
      oldString: { type: 'string' },
      newString: { type: 'string' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
})

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description: 'Delete a single file. Fails if the path is a directory — use delete_dir for that.',
  nativeFn: 'deleteFile',
  schema: z.object({ path: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
})

export const deleteDirTool = defineTool({
  name: 'delete_dir',
  description:
    'Delete a directory. Non-recursive by default — fails on a non-empty ' +
    'directory unless recursive is set.',
  nativeFn: 'deleteDir',
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

export const createDirTool = defineTool({
  name: 'create_dir',
  description: 'Create a directory, creating any missing parents. Idempotent.',
  nativeFn: 'createDir',
  schema: z.object({ path: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
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

export const copyFileTool = defineTool({
  name: 'copy_file',
  description: 'Copy a file. Refuses to replace an existing destination unless overwrite is set.',
  nativeFn: 'copyFile',
  schema: z.object({ source: z.string(), destination: z.string(), overwrite: z.boolean().optional() }),
  jsonSchema: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      destination: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    required: ['source', 'destination'],
    additionalProperties: false,
  },
})

export const renameFileTool = defineTool({
  name: 'rename_file',
  description: 'Rename (move) a file. Refuses to replace an existing destination unless overwrite is set.',
  nativeFn: 'renameFile',
  schema: z.object({ source: z.string(), destination: z.string(), overwrite: z.boolean().optional() }),
  jsonSchema: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      destination: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    required: ['source', 'destination'],
    additionalProperties: false,
  },
})

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    'Run a program directly, without a shell. Pass arguments as an array, not ' +
    'a single command string — there is no shell to parse pipes or globs.',
  nativeFn: 'runCommand',
  schema: z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Argument vector, no shell interpretation.',
      },
      cwd: { type: 'string' },
    },
    required: ['command'],
    additionalProperties: false,
  },
})

// ---------------------------------------------------------------------------
// KiCad tools — schematic → PCB generation
// ---------------------------------------------------------------------------

export const parseSchematicTool = defineTool({
  name: 'parse_schematic',
  description:
    'Parse a .kicad_sch file and return its components, nets, and connections. ' +
    'This is the first step before generating a PCB layout.',
  nativeFn: 'parseSchematic',
  schema: z.object({ path: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .kicad_sch file.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
})

export const generatePcbTool = defineTool({
  name: 'generate_pcb',
  description:
    'Generate a .kicad_pcb file from a schematic and board constraints. ' +
    'The generated file can be opened in KiCad for manual routing.',
  nativeFn: 'generatePcb',
  schema: z.object({
    schematicPath: z.string(),
    outputPath: z.string().optional(),
    constraints: z.object({
      width: z.number().describe('Board width in mm'),
      height: z.number().describe('Board height in mm'),
      layers: z.union([z.literal(1), z.literal(2), z.literal(4)]),
      groundPlane: z.boolean().optional(),
      designRules: z.object({
        minTraceWidth: z.number().optional(),
        minClearance: z.number().optional(),
        minViaDrill: z.number().optional(),
        minViaSize: z.number().optional(),
      }).optional(),
    }),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      schematicPath: { type: 'string', description: 'Path to the .kicad_sch file.' },
      outputPath: { type: 'string', description: 'Output path for the .kicad_pcb file.' },
      constraints: {
        type: 'object',
        description: 'Board constraints: { width: number, height: number, layers: 1|2|4, groundPlane?: boolean, designRules?: { minTraceWidth?: number, minClearance?: number, minViaDrill?: number, minViaSize?: number } }',
      },
    },
    required: ['schematicPath', 'constraints'],
    additionalProperties: false,
  },
})

export const runDrcTool = defineTool({
  name: 'run_drc',
  description:
    'Run Design Rule Check on a .kicad_pcb file. Returns a report of violations ' +
    '(clearance errors, track width issues, etc.).',
  nativeFn: 'runDrc',
  schema: z.object({ path: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .kicad_pcb file.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
})

export const exportGerbersTool = defineTool({
  name: 'export_gerbers',
  description:
    'Export Gerber and drill files from a .kicad_pcb for PCB fabrication.',
  nativeFn: 'exportGerbers',
  schema: z.object({ pcbPath: z.string(), outputDir: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      pcbPath: { type: 'string', description: 'Path to the .kicad_pcb file.' },
      outputDir: { type: 'string', description: 'Directory to write Gerber files to.' },
    },
    required: ['pcbPath', 'outputDir'],
    additionalProperties: false,
  },
})

export const exportBomTool = defineTool({
  name: 'export_bom',
  description:
    'Export a Bill of Materials from a .kicad_sch file.',
  nativeFn: 'exportBom',
  schema: z.object({ schPath: z.string(), outputPath: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: {
      schPath: { type: 'string', description: 'Path to the .kicad_sch file.' },
      outputPath: { type: 'string', description: 'Output path for the BOM CSV.' },
    },
    required: ['schPath', 'outputPath'],
    additionalProperties: false,
  },
})

export const toolDefinitions = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  delete_file: deleteFileTool,
  delete_dir: deleteDirTool,
  create_dir: createDirTool,
  list_files: listFilesTool,
  copy_file: copyFileTool,
  rename_file: renameFileTool,
  run_command: runCommandTool,
  parse_schematic: parseSchematicTool,
  generate_pcb: generatePcbTool,
  run_drc: runDrcTool,
  export_gerbers: exportGerbersTool,
  export_bom: exportBomTool,
} as const satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof toolDefinitions

/** The `tools` array shape OpenRouter's OpenAI-compatible API expects. */
export function toOpenAiToolSpecs() {
  return Object.values(toolDefinitions).map((def) => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.jsonSchema,
    },
  }))
}
