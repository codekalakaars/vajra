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
