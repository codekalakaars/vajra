import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolDefinitions, toOpenAiToolSpecs } from '../dist/index.js'

test('every tool schema validates its own well-formed example', () => {
  const examples = {
    read_file: { path: 'a.txt' },
    list_files: { path: '.', recursive: false },
    search_files: { query: 'function readFile' },
    run_command: { command: 'cargo test', cwd: '.', timeoutMs: 30000 },
    write_file: { path: 'a.txt', content: 'hello' },
    edit_file: { path: 'a.txt', oldString: 'foo', newString: 'bar' },
    propose_plan: {
      tasks: [
        {
          id: 'add-auth-middleware',
          title: 'Add auth middleware',
          description: 'Create JWT auth middleware',
          instructions: ['Create JWT auth middleware in src/middleware/auth.ts'],
          readFile: ['src/middleware/auth.ts'],
          writeFile: ['src/middleware/auth.ts'],
          deleteFile: [],
          createDir: ['src/middleware'],
          validation: ['cargo test'],
          dependsOn: [],
          type: 'create',
        },
      ],
      summary: 'Add JWT authentication',
    },
  }

  for (const [name, def] of Object.entries(toolDefinitions)) {
    assert.ok(examples[name], `no example for ${name}`)
    const parsed = def.schema.parse(examples[name])
    assert.deepEqual(parsed, examples[name])
  }
})

test('propose_plan requires a model-supplied task id (C3)', () => {
  assert.throws(() =>
    toolDefinitions.propose_plan.schema.parse({
      tasks: [{ title: 'no id', description: 'd' }],
      summary: 's',
    }),
  )
})

test('propose_plan accepts ordinary plans that omit empty arrays', () => {
  const bare = toolDefinitions.propose_plan.schema.parse({
    tasks: [
      {
        id: 'fix-login',
        title: 'Fix login bug',
        description: 'The login form never submits',
        type: 'modify',
      },
    ],
    summary: 'Fix login form submit',
  })
  assert.equal(bare.tasks[0].id, 'fix-login')
  assert.deepEqual(bare.tasks[0].instructions, [])
  assert.deepEqual(bare.tasks[0].deleteFile, [])
  assert.deepEqual(bare.tasks[0].createDir, [])
  assert.deepEqual(bare.tasks[0].validation, [])
  assert.equal(bare.tasks[0].type, 'modify')
})

test('propose_plan accepts a single validation string', () => {
  const plan = toolDefinitions.propose_plan.schema.parse({
    tasks: [
      {
        id: 'add-tests',
        title: 'Add tests',
        description: 'Cover the new module',
        validation: 'pnpm test',
      },
    ],
    summary: 'Add tests',
  })
  assert.deepEqual(plan.tasks[0].validation, ['pnpm test'])
})

test('run_command uses timeoutMs in milliseconds (C5)', () => {
  const parsed = toolDefinitions.run_command.schema.parse({ command: 'echo hi', timeoutMs: 1000 })
  assert.equal(parsed.timeoutMs, 1000)
})

test('no tool definition carries a nativeFn field (J8)', () => {
  for (const def of Object.values(toolDefinitions)) {
    assert.equal('nativeFn' in def, false)
  }
})

test('tool schemas reject malformed arguments', () => {
  assert.throws(() => toolDefinitions.read_file.schema.parse({}))
})

test('run_shell is deliberately not offered', () => {
  assert.equal(toolDefinitions.run_shell, undefined)
})

test('toOpenAiToolSpecs produces the OpenAI-compatible tools[] shape', () => {
  const specs = toOpenAiToolSpecs()
  assert.equal(specs.length, Object.keys(toolDefinitions).length)

  for (const spec of specs) {
    assert.equal(spec.type, 'function')
    assert.equal(typeof spec.function.name, 'string')
    assert.equal(typeof spec.function.description, 'string')
    assert.equal(spec.function.parameters.type, 'object')
    assert.equal(spec.function.parameters.additionalProperties, false)
  }

  const readFile = specs.find((s) => s.function.name === 'read_file')
  assert.deepEqual(readFile.function.parameters.required, ['path'])
})
