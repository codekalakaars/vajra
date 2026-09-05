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

export const toolDefinitions = {
  read_file: readFileTool,
  list_files: listFilesTool,
  search_files: searchFilesTool,
  run_command: runCommandTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
} as const satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof toolDefinitions

/** Tools available to each agent role. */
export const roleTools: Record<string, ToolName[]> = {
  manager: ['read_file', 'list_files', 'search_files'],
  master: ['read_file', 'list_files', 'search_files', 'run_command'],
  worker: ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'],
}

/** The `tools` array shape OpenRouter's OpenAI-compatible API expects. */
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
