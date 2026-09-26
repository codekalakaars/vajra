// Library test generation, per language.
//
// Surface 1 — a pure function or a public API — is the same idea in every
// language: call it, assert on the return value or the throw. Only the syntax
// differs, so each language is a template over one shared case shape.
//
// As with components, the project's own framework runs the result, so there is
// nothing to execute here and no dependency to take: these are string builders.

export type LibraryLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'ruby'
  | 'csharp'

export interface LibraryCase {
  name: string
  /** The call under test, as written in the target language. */
  call: string
  /** Assert the result deep-equals this. Omit to assert only that it returns. */
  equals?: unknown
  /** Assert the call throws. */
  throws?: boolean
  /** For languages with no deep equality: a boolean expression. */
  assert?: string
}

export interface LibrarySpec {
  language: LibraryLanguage
  /** Where the generated file goes, e.g. './sum.test.ts'. */
  path: string
  /** Import lines the case calls need, already written for the language. */
  imports?: readonly string[]
  cases: readonly LibraryCase[]
  testRunner?: 'vitest' | 'jest' | 'pytest'
}

export interface GeneratedLibraryTest {
  path: string
  contents: string
  language: LibraryLanguage
  runCommand: readonly string[]
}

export function generateLibraryTest(spec: LibrarySpec): GeneratedLibraryTest {
  switch (spec.language) {
    case 'typescript':
    case 'javascript':
      return jsLike(spec)
    case 'python':
      return python(spec)
    case 'go':
      return go(spec)
    case 'rust':
      return rust(spec)
    case 'java':
      return java(spec)
    case 'ruby':
      return ruby(spec)
    case 'csharp':
      return csharp(spec)
  }
}

const jsRunner = (runner: 'vitest' | 'jest') =>
  runner === 'jest' ? "from '@jest/globals'" : "from 'vitest'"

function jsLike(spec: LibrarySpec): GeneratedLibraryTest {
  const runner = spec.testRunner === 'jest' ? 'jest' : 'vitest'
  const lines = [
    `import { describe, it, expect${spec.cases.some((c) => c.throws) ? ', vi' : ''} } ${jsRunner(runner)}`,
    ...(spec.imports ?? []),
    '',
  ]
  for (const testCase of spec.cases) {
    lines.push(`describe(${JSON.stringify(testCase.name)}, () => {`)
    if (testCase.throws) {
      lines.push(`  it('throws', () => {`)
      lines.push(`    expect(() => ${testCase.call}).toThrow()`)
      lines.push(`  })`)
    } else if (testCase.assert) {
      lines.push(`  it('holds', () => {`)
      lines.push(`    expect(${testCase.assert}).toBe(true)`)
      lines.push(`  })`)
    } else {
      lines.push(`  it('returns the expected value', () => {`)
      lines.push(
        testCase.equals === undefined
          ? `    expect(${testCase.call}).toBeDefined()`
          : `    expect(${testCase.call}).toEqual(${JSON.stringify(testCase.equals)})`,
      )
      lines.push(`  })`)
    }
    lines.push('})')
    lines.push('')
  }
  return finish(spec, lines, runner === 'jest' ? ['npx', 'jest'] : ['npx', 'vitest', 'run'])
}

function python(spec: LibrarySpec): GeneratedLibraryTest {
  const lines = [...(spec.imports ?? []), '']
  for (const testCase of spec.cases) {
    lines.push(`def test_${slug(testCase.name)}():`)
    if (testCase.throws) {
      lines.push(`    with pytest.raises(Exception):`)
      lines.push(`        ${testCase.call}`)
    } else if (testCase.assert) {
      lines.push(`    assert ${testCase.assert}`)
    } else if (testCase.equals !== undefined) {
      lines.push(`    assert ${testCase.call} == ${pythonLiteral(testCase.equals)}`)
    } else {
      lines.push(`    assert ${testCase.call} is not None`)
    }
    lines.push('')
  }
  if (spec.cases.some((c) => c.throws) && !lines[0]?.includes('pytest')) {
    lines.unshift('import pytest', '')
  }
  return finish(spec, lines, ['python', '-m', 'pytest', '-q'])
}

function go(spec: LibrarySpec): GeneratedLibraryTest {
  // The package clause must precede every import; emitting them the other way
  // round produces a file that will not compile.
  const pkg = spec.imports?.[0]?.match(/package (\w+)/)?.[1] ?? 'main'
  const body = spec.imports?.filter((line) => !line.startsWith('package ')) ?? []
  const lines = [`package ${pkg}`, '', ...body]
  for (const testCase of spec.cases) {
    lines.push(`func Test${titleCase(testCase.name)}(t *testing.T) {`)
    if (testCase.throws) {
      lines.push(`\tdefer func() {`)
      lines.push(`\t\tif recover() == nil {`)
      lines.push(`\t\t\tt.Fatal("expected a panic")`)
      lines.push(`\t\t}`)
      lines.push(`\t}()`)
      lines.push(`\t${testCase.call}`)
    } else if (testCase.assert) {
      lines.push(`\tif !(${testCase.assert}) {`)
      lines.push(`\t\tt.Fatal("assertion failed")`)
      lines.push(`\t}`)
    } else if (testCase.equals !== undefined) {
      lines.push(`\tgot := ${testCase.call}`)
      lines.push(`\twant := ${goLiteral(testCase.equals)}`)
      lines.push(`\tif !reflect.DeepEqual(got, want) {`)
      lines.push(`\t\tt.Fatalf("got %v, want %v", got, want)`)
      lines.push(`\t}`)
    }
    lines.push(`}`)
    lines.push('')
  }
  if (spec.cases.some((c) => c.equals !== undefined)) {
    lines.splice(2, 0, 'import "reflect"', '')
  }
  return finish(spec, lines, ['go', 'test', './...'])
}

function rust(spec: LibrarySpec): GeneratedLibraryTest {
  const lines = ['#[cfg(test)]', 'mod tests {', '    use super::*;', '']
  for (const testCase of spec.cases) {
    lines.push(`    #[test]`)
    lines.push(`    fn ${slug(testCase.name)}() {`)
    if (testCase.throws) {
      lines.push(`        assert!(std::panic::catch_unwind(|| { ${testCase.call} }).is_err());`)
    } else if (testCase.assert) {
      lines.push(`        assert!(${testCase.assert});`)
    } else if (testCase.equals !== undefined) {
      lines.push(`        assert_eq!(${testCase.call}, ${rustLiteral(testCase.equals)});`)
    }
    lines.push(`    }`)
    lines.push('')
  }
  lines.push('}')
  return finish(spec, lines, ['cargo', 'test'])
}

function java(spec: LibrarySpec): GeneratedLibraryTest {
  const lines = [...(spec.imports ?? []), '']
  for (const testCase of spec.cases) {
    lines.push(`    @Test`)
    lines.push(`    void ${slug(testCase.name)}() {`)
    if (testCase.throws) {
      lines.push(`        assertThrows(RuntimeException.class, () -> { ${testCase.call} });`)
    } else if (testCase.assert) {
      lines.push(`        assertTrue(${testCase.assert});`)
    } else {
      lines.push(`        assertNotNull(${testCase.call});`)
    }
    lines.push(`    }`)
    lines.push('')
  }
  return finish(spec, lines, ['./mvnw', '-q', 'test'])
}

function ruby(spec: LibrarySpec): GeneratedLibraryTest {
  const lines = ["require 'minitest/autorun'", "require 'spec_helper'", '']
  for (const testCase of spec.cases) {
    lines.push(`class ${titleCase(testCase.name)}Test < Minitest::Test`)
    lines.push(`  def test_${slug(testCase.name)}`)
    if (testCase.throws) {
      lines.push(`    assert_raises(RuntimeError) { ${testCase.call} }`)
    } else if (testCase.assert) {
      lines.push(`    assert ${testCase.assert}`)
    } else {
      lines.push(`    refute_nil ${testCase.call}`)
    }
    lines.push('  end')
    lines.push('end')
    lines.push('')
  }
  return finish(spec, lines, ['bundle', 'exec', 'rake', 'test'])
}

function csharp(spec: LibrarySpec): GeneratedLibraryTest {
  const lines = ['using Xunit;', ...(spec.imports ?? []), '', 'public class GeneratedTests', '{']
  for (const testCase of spec.cases) {
    lines.push(`    [Fact]`)
    lines.push(`    public void ${titleCase(testCase.name)}()`)
    lines.push('    {')
    if (testCase.throws) {
      lines.push(`        Assert.ThrowsAny<Exception>(() => { ${testCase.call} });`)
    } else if (testCase.assert) {
      lines.push(`        Assert.True(${testCase.assert});`)
    } else {
      lines.push(`        Assert.NotNull(${testCase.call});`)
    }
    lines.push('    }')
    lines.push('')
  }
  lines.push('}')
  return finish(spec, lines, ['dotnet', 'test'])
}

function finish(
  spec: LibrarySpec,
  lines: string[],
  runCommand: readonly string[],
): GeneratedLibraryTest {
  return {
    path: spec.path,
    contents: `${lines.join('\n').trimEnd()}\n`,
    language: spec.language,
    runCommand,
  }
}

function slug(text: string): string {
  return text
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'case'
}

function titleCase(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join('')
}

function pythonLiteral(value: unknown): string {
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(', ')}]`
  return JSON.stringify(value)
}

function goLiteral(value: unknown): string {
  if (value === null) return 'nil'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[]any{${value.map(goLiteral).join(', ')}}`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${goLiteral(v)}`)
      .join(', ')}}`
  }
  return JSON.stringify(value)
}

function rustLiteral(value: unknown): string {
  if (value === null) return 'None'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `vec![${value.map(rustLiteral).join(', ')}]`
  return JSON.stringify(value)
}
