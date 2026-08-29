import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolDefinitions, toOpenAiToolSpecs } from '../dist/index.js'

test('every tool schema validates its own well-formed example', () => {
  const examples = {
    read_file: { path: 'a.txt' },
    write_file: { path: 'a.txt', content: 'hi' },
    edit_file: { path: 'a.txt', oldString: 'x', newString: 'y' },
    delete_file: { path: 'a.txt' },
    delete_dir: { path: 'a', recursive: true },
    create_dir: { path: 'a/b/c' },
    list_files: { path: '.', recursive: false },
    copy_file: { source: 'a', destination: 'b' },
    rename_file: { source: 'a', destination: 'b', overwrite: true },
    run_command: { command: 'git', args: ['status'] },
  }

  for (const [name, def] of Object.entries(toolDefinitions)) {
    assert.ok(examples[name], `no example for ${name}`)
    const parsed = def.schema.parse(examples[name])
    assert.deepEqual(parsed, examples[name])
  }
})

test('tool schemas reject malformed arguments', () => {
  assert.throws(() => toolDefinitions.read_file.schema.parse({}))
  assert.throws(() => toolDefinitions.edit_file.schema.parse({ path: 'a' }))
  assert.throws(() => toolDefinitions.run_command.schema.parse({ command: 5 }))
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

  const runCommand = specs.find((s) => s.function.name === 'run_command')
  assert.deepEqual(runCommand.function.parameters.required, ['command'])
})
