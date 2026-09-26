// Component test generation — Mechanism B.
//
// The insight that makes this tractable: a component test establishes five
// properties, and those five are the same in every framework. Only the imports
// and two or three call shapes differ. So the hard part — knowing *what* to
// assert — is shared, and the easy part is a template.
//
// A new framework therefore needs a generator, never a runner. Driving
// @testing-library/react from outside would mean reimplementing a renderer,
// which is absurd when the package is already a devDependency of the project
// under test. The generator emits a test file in the project's own idiom, the
// project's own runner executes it, and the existing JUnit ingestion handles
// the result.
//
// Deliberate exclusions:
//
//   Snapshots. A snapshot records whatever the component currently renders,
//   including whatever is wrong, then demands a human review the diff. That is
//   a review, not a test.
//
//   Class names and internal state. They break on every refactor while proving
//   nothing about behaviour. Everything here queries by role, name or text, so
//   a probe survives restyling and fails on a real regression.

export type Framework = 'react' | 'vue' | 'svelte' | 'angular'

export interface AccessibleQuery {
  role?: string
  name?: string
  text?: string
  label?: string
  testId?: string
}

export interface Interaction {
  /** The element to interact with. */
  on: AccessibleQuery
  /** A callback prop or emitted event expected to have fired. */
  expectEvent?: string
  /** Arguments the event is expected to have received. */
  withArgs?: readonly unknown[]
  /** Text expected after the interaction. */
  thenRenders?: readonly string[]
}

export interface ComponentCase {
  name: string
  props?: Record<string, unknown>
  /** Text that must appear in the rendered output. */
  renders?: readonly string[]
  /** Elements that must be findable by an accessible query. */
  queries?: readonly AccessibleQuery[]
  /** Interactions, applied in order. */
  interactions?: readonly Interaction[]
}

export interface ComponentSpec {
  framework: Framework
  /** Module specifier as written in the project, e.g. './LoginForm'. */
  module: string
  /** Exported component name. */
  exportName: string
  cases: readonly ComponentCase[]
  /** Defaults per framework. */
  testRunner?: 'vitest' | 'jest'
  /** File extension override; a .vue or .svelte source may want .ts. */
  extension?: string
}

export interface GeneratedTest {
  path: string
  contents: string
  framework: Framework
  /** How the project's runner will execute it. */
  runCommand: readonly string[]
  /** Named exports the spec expects to exist, for validation. */
  requiredCallbacks: string[]
}

const RUNNERS = {
  vitest: { import: "from 'vitest'", run: ['npx', 'vitest', 'run'] },
  jest: { import: "from '@jest/globals'", run: ['npx', 'jest'] },
} as const

/** Every callback prop a case interacts with, across all cases. */
export function requiredCallbacks(spec: ComponentSpec): string[] {
  const found = new Set<string>()
  for (const testCase of spec.cases) {
    for (const step of testCase.interactions ?? []) {
      if (step.expectEvent) found.add(step.expectEvent)
    }
  }
  return [...found].sort()
}

export function generateComponentTest(spec: ComponentSpec): GeneratedTest {
  switch (spec.framework) {
    case 'react':
      return react(spec)
    case 'vue':
      return vue(spec)
    case 'svelte':
      return svelte(spec)
    case 'angular':
      return angular(spec)
  }
}

function header(spec: ComponentSpec, runner: keyof typeof RUNNERS): string {
  const r = RUNNERS[runner]
  return `import { describe, it, expect, vi } ${r.import}`
}

function defaultExtension(spec: ComponentSpec): string {
  return spec.extension ?? '.test.ts'
}

function pathFor(spec: ComponentSpec, ext: string): string {
  const base = spec.module.replace(/^\.\//, '').replace(/\.(tsx?|jsx?|vue|svelte)$/, '')
  return `./${base}${ext}`
}

// --- React ---

function react(spec: ComponentSpec): GeneratedTest {
  const runner = spec.testRunner ?? 'vitest'
  const callbacks = requiredCallbacks(spec)
  const needsSpy = callbacks.length > 0

  const lines: string[] = [
    header(spec, runner),
    `import { render, screen, fireEvent } from '@testing-library/react'`,
    `import { ${spec.exportName} } from '${spec.module}'`,
    '',
    `describe('${spec.exportName}', () => {`,
  ]

  for (const testCase of spec.cases) {
    lines.push(`  it(${q(testCase.name)}, () => {`)
    const used = callbacks.filter((c) =>
      testCase.interactions?.some((s) => s.expectEvent === c),
    )
    const props = { ...(testCase.props ?? {}) }
    for (const name of used) {
      if (!(name in props)) props[name] = 'SPY'
    }

    const hasProps = Object.keys(props).length > 0
    lines.push(
      hasProps
        ? `    const props = { ${renderProps(props, needsSpy)} }`
        : `    const props = {}`,
    )
    lines.push(`    render(<${spec.exportName} {...props} />)`)
    lines.push('')

    for (const text of testCase.renders ?? []) {
      lines.push(`    expect(screen.getByText(${q(text)})).toBeDefined()`)
    }
    for (const query of testCase.queries ?? []) {
      lines.push(`    ${reactQuery(query)}`)
    }
    for (const step of testCase.interactions ?? []) {
      lines.push(`    fireEvent.click(${reactLocator(step.on)})`)
      if (step.expectEvent) {
        const args = step.withArgs?.length ? `, ${step.withArgs.map(q).join(', ')}` : ''
        lines.push(`    expect(props.${step.expectEvent}).toHaveBeenCalled${args ? `With(${args.slice(2)})` : '()'}`)
      }
      for (const text of step.thenRenders ?? []) {
        lines.push(`    expect(screen.getByText(${q(text)})).toBeDefined()`)
      }
    }
    lines.push('  })')
    lines.push('')
  }

  lines.push('})')
  return {
    path: pathFor(spec, defaultExtension(spec)),
    contents: `${lines.join('\n').trimEnd()}\n`,
    framework: 'react',
    runCommand: [...RUNNERS[runner].run],
    requiredCallbacks: callbacks,
  }
}

/**
 * Emit a props object. A `SPY` sentinel becomes a real `vi.fn()` call rather
 * than the string "vi.fn()" — a mistake that produces a test file which parses
 * cleanly and then fails for an unrelated reason.
 */
function renderProps(props: Record<string, unknown>, needsSpy: boolean): string {
  return Object.entries(props)
    .map(([key, value]) => {
      if (value === 'SPY' && needsSpy) return `${key}: vi.fn()`
      return `${key}: ${literal(value)}`
    })
    .join(', ')
}

function literal(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value) ?? 'undefined'
}

function reactQuery(query: AccessibleQuery): string {
  if (query.testId) return `expect(screen.getByTestId(${q(query.testId)})).toBeDefined()`
  if (query.role) {
    const options = query.name ? `, { name: ${q(query.name)} }` : ''
    return `expect(screen.getByRole(${q(query.role)}${options})).toBeDefined()`
  }
  if (query.label) return `expect(screen.getByLabelText(${q(query.label)})).toBeDefined()`
  return `expect(screen.getByText(${q(query.text ?? '')})).toBeDefined()`
}

function reactLocator(query: AccessibleQuery): string {
  if (query.testId) return `screen.getByTestId(${q(query.testId)})`
  if (query.role) {
    const options = query.name ? `, { name: ${q(query.name)} }` : ''
    return `screen.getByRole(${q(query.role)}${options})`
  }
  if (query.label) return `screen.getByLabelText(${q(query.label)})`
  return `screen.getByText(${q(query.text ?? '')})`
}

// --- Vue ---

function vue(spec: ComponentSpec): GeneratedTest {
  const runner = spec.testRunner ?? 'vitest'
  const lines: string[] = [
    header(spec, runner),
    `import { mount } from '@vue/test-utils'`,
    `import ${spec.exportName} from '${spec.module}'`,
    '',
    `describe('${spec.exportName}', () => {`,
  ]

  for (const testCase of spec.cases) {
    lines.push(`  it(${q(testCase.name)}, async () => {`)
    const props = { ...(testCase.props ?? {}) }
    const spies: string[] = []
    for (const step of testCase.interactions ?? []) {
      if (step.expectEvent && !(step.expectEvent in props)) {
        props[step.expectEvent] = 'SPY'
        spies.push(step.expectEvent)
      }
    }
    const hasProps = Object.keys(props).length > 0
    lines.push(
      hasProps
        ? `    const wrapper = mount(${spec.exportName}, { props: { ${renderProps(props, true)} } })`
        : `    const wrapper = mount(${spec.exportName})`,
    )
    lines.push('')

    for (const text of testCase.renders ?? []) {
      lines.push(`    expect(wrapper.text()).toContain(${q(text)})`)
    }
    for (const query of testCase.queries ?? []) {
      lines.push(`    ${vueQuery(query)}`)
    }
    for (const step of testCase.interactions ?? []) {
      lines.push(`    await wrapper.find(${vueSelector(step.on)}).trigger('click')`)
      if (step.expectEvent) {
        const args = step.withArgs?.length
          ? `expect(wrapper.emitted(${q(step.expectEvent)})?.[0]).toEqual([${step.withArgs.map(q).join(', ')}])`
          : `expect(wrapper.emitted(${q(step.expectEvent)})).toBeTruthy()`
        lines.push(`    ${args}`)
      }
      for (const text of step.thenRenders ?? []) {
        lines.push(`    expect(wrapper.text()).toContain(${q(text)})`)
      }
    }
    lines.push('  })')
    lines.push('')
  }

  lines.push('})')
  return {
    path: pathFor(spec, defaultExtension(spec)),
    contents: `${lines.join('\n').trimEnd()}\n`,
    framework: 'vue',
    runCommand: [...RUNNERS[runner].run],
    requiredCallbacks: requiredCallbacks(spec),
  }
}

function vueQuery(query: AccessibleQuery): string {
  if (query.testId) return `expect(wrapper.find('[data-testid="${query.testId}"]').exists()).toBe(true)`
  if (query.role) {
    const name = query.name ? `[aria-label="${query.name}"]` : ''
    return `expect(wrapper.find('[role="${query.role}"]${name}').exists()).toBe(true)`
  }
  if (query.label) return `expect(wrapper.find('label').text()).toContain(${q(query.label)})`
  return `expect(wrapper.text()).toContain(${q(query.text ?? '')})`
}

function vueSelector(query: AccessibleQuery): string {
  if (query.testId) return `'[data-testid="${query.testId}"]'`
  if (query.role) {
    const name = query.name ? `[aria-label="${query.name}"]` : ''
    return `'[role="${query.role}"]${name}'`
  }
  if (query.label) return `'label'`
  return `'button'`
}

// --- Svelte ---

function svelte(spec: ComponentSpec): GeneratedTest {
  const runner = spec.testRunner ?? 'vitest'
  const lines: string[] = [
    header(spec, runner),
    `import { render, screen, fireEvent } from '@testing-library/svelte'`,
    `import ${spec.exportName} from '${spec.module}'`,
    '',
    `describe('${spec.exportName}', () => {`,
  ]

  for (const testCase of spec.cases) {
    lines.push(`  it(${q(testCase.name)}, () => {`)
    const props = { ...(testCase.props ?? {}) }
    const spies: string[] = []
    for (const step of testCase.interactions ?? []) {
      if (step.expectEvent && !(step.expectEvent in props)) {
        props[step.expectEvent] = 'SPY'
        spies.push(step.expectEvent)
      }
    }
    const hasProps = Object.keys(props).length > 0
    lines.push(
      hasProps
        ? `    render(${spec.exportName}, { props: { ${renderProps(props, true)} } })`
        : `    render(${spec.exportName})`,
    )
    lines.push('')

    for (const text of testCase.renders ?? []) {
      lines.push(`    expect(screen.getByText(${q(text)})).toBeDefined()`)
    }
    for (const query of testCase.queries ?? []) {
      lines.push(`    ${reactQuery(query)}`)
    }
    for (const step of testCase.interactions ?? []) {
      lines.push(`    await fireEvent.click(${reactLocator(step.on)})`)
      if (step.expectEvent) {
        const args = step.withArgs?.length ? `, ${step.withArgs.map(q).join(', ')}` : ''
        lines.push(`    expect(props.${step.expectEvent}).toHaveBeenCalled${args ? `With(${args.slice(2)})` : '()'}`)
      }
      for (const text of step.thenRenders ?? []) {
        lines.push(`    expect(screen.getByText(${q(text)})).toBeDefined()`)
      }
    }
    lines.push('  })')
    lines.push('')
  }

  lines.push('})')
  return {
    path: pathFor(spec, defaultExtension(spec)),
    contents: `${lines.join('\n').trimEnd()}\n`,
    framework: 'svelte',
    runCommand: [...RUNNERS[runner].run],
    requiredCallbacks: requiredCallbacks(spec),
  }
}

// --- Angular ---

function angular(spec: ComponentSpec): GeneratedTest {
  const lines: string[] = [
    `import { TestBed } from '@angular/core/testing'`,
    `import { ${spec.exportName} } from '${spec.module}'`,
    '',
    `describe('${spec.exportName}', () => {`,
  ]

  for (const testCase of spec.cases) {
    lines.push(`  it(${q(testCase.name)}, async () => {`)
    lines.push(`    await TestBed.configureTestingModule({ imports: [${spec.exportName}] })`)
    lines.push(`      .compileComponents()`)
    lines.push(`    const fixture = TestBed.createComponent(${spec.exportName})`)
    const props = testCase.props ?? {}
    if (Object.keys(props).length > 0) {
      const assigns = Object.entries(props)
        .map(([key, value]) => `fixture.componentInstance.${key} = ${literal(value)}`)
        .join('\n      ')
      lines.push(`    ${assigns}`)
    }
    lines.push(`    fixture.detectChanges()`)
    lines.push(`    const el = fixture.nativeElement as HTMLElement`)
    lines.push('')

    for (const text of testCase.renders ?? []) {
      lines.push(`    expect(el.textContent).toContain(${q(text)})`)
    }
    for (const query of testCase.queries ?? []) {
      lines.push(`    ${angularQuery(query)}`)
    }
    for (const step of testCase.interactions ?? []) {
      lines.push(`    ${angularSelector(step.on)}.click()`)
      lines.push(`    fixture.detectChanges()`)
      if (step.expectEvent) {
        const key = spec.exportName
        lines.push(`    expect(fixture.componentInstance.${step.expectEvent}).toHaveBeenCalled()`)
        void key
      }
      for (const text of step.thenRenders ?? []) {
        lines.push(`    expect(el.textContent).toContain(${q(text)})`)
      }
    }
    lines.push('  })')
    lines.push('')
  }

  lines.push('})')
  return {
    path: pathFor(spec, defaultExtension(spec)),
    contents: `${lines.join('\n').trimEnd()}\n`,
    framework: 'angular',
    runCommand: ['npx', 'ng', 'test', '--watch=false'],
    requiredCallbacks: requiredCallbacks(spec),
  }
}

function angularQuery(query: AccessibleQuery): string {
  if (query.testId) return `expect(el.querySelector('[data-testid="${query.testId}"]')).toBeTruthy()`
  if (query.role) {
    const name = query.name ? `[aria-label="${query.name}"]` : ''
    return `expect(el.querySelector('[role="${query.role}"]${name}')).toBeTruthy()`
  }
  if (query.label) return `expect(el.querySelector('label')?.textContent).toContain(${q(query.label)})`
  return `expect(el.textContent).toContain(${q(query.text ?? '')})`
}

function angularSelector(query: AccessibleQuery): string {
  if (query.testId) return `el.querySelector('[data-testid="${query.testId}"]')!`
  if (query.role) {
    const name = query.name ? `[aria-label="${query.name}"]` : ''
    return `el.querySelector('[role="${query.role}"]${name}')!`
  }
  if (query.label) return `el.querySelector('label')!`
  return `el.querySelector('button')!`
}

function q(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined'
}
