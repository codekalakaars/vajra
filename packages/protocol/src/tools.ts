// Tool schema the agent's model sees, and what each tool dispatches to.
// run_shell is deliberately not offered — run_command (argv-based, no shell)
// covers file-editing tasks without the shell-injection surface.
// This package does not import vajra-core — browser bundles can't load .node.

import { z } from 'zod'

interface JsonSchemaProperty {
  type: string
  description?: string
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
    'or occurs more than once unless replaceAll is set.',
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
    'Run a program directly, without a shell. Pass arguments as an array.',
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
