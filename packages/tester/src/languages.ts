// Per-language import extraction and resolution.
//
// Test selection only works if the system can see which files depend on which.
// The first implementation hardcoded a JavaScript-shaped regex, which meant a
// Python, Rust, Go or Java change selected no tests at all — and a selection
// that returns nothing is indistinguishable from "nothing is affected", so the
// affected tests silently never ran.
//
// A language is described here as data: how to spot its files, how to recognise
// its tests, how to pull specifiers out of source, and what paths those
// specifiers could resolve to. Adding a language is adding an entry.

export interface LanguageSpec {
  name: string
  /** File extensions, without the leading dot. */
  extensions: readonly string[]
  /** Recognises test files for this language. */
  testPattern: RegExp
  /** Pull dependency specifiers out of source. */
  extract: (source: string) => string[]
  /**
   * Candidate repo-relative paths for a specifier, most specific first. An
   * empty array means the specifier is not resolvable to a path — which is
   * normal for third-party dependencies and a defect for internal ones.
   */
  candidates: (specifier: string, importer: string) => string[]
  /** Files that behave as global configuration for this language. */
  configPatterns?: readonly RegExp[]
}

const dir = (file: string): string => {
  const cut = file.lastIndexOf('/')
  return cut === -1 ? '' : file.slice(0, cut)
}

const norm = (path: string): string => {
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*#.*$/gm, ' ')

/** Collect every match of a pattern, de-duplicated and order-preserving. */
function collect(source: string, pattern: RegExp, group = 1): string[] {
  const found = new Set<string>()
  const re = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const value = match[group]
    if (value) found.add(value)
    if (match.index === re.lastIndex) re.lastIndex += 1
  }
  return [...found]
}

// --- JavaScript / TypeScript ---

const JS_LIKE = /\.(js|jsx|mjs|cjs)$/
const JS_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']

const jsCandidates = (specifier: string, importer: string): string[] => {
  if (!specifier.startsWith('.')) return []
  const base = norm(`${dir(importer)}/${specifier}`)
  const out: string[] = []
  const jsMatch = JS_LIKE.exec(base)
  if (jsMatch) {
    // TypeScript ESM writes `./util.js` for a file that is `util.ts`.
    const stem = base.slice(0, -jsMatch[0].length)
    out.push(...(jsMatch[1] === 'mjs' ? ['.mts'] : jsMatch[1] === 'cjs' ? ['.cts'] : ['.ts', '.tsx']).map((e) => `${stem}${e}`))
  }
  out.push(...JS_EXTENSIONS.map((e) => `${base}${e}`))
  out.push(...JS_EXTENSIONS.slice(1).map((e) => `${base}/index${e}`))
  return out
}

export const javascript: LanguageSpec = {
  name: 'javascript',
  extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'],
  testPattern: /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  extract: (source) => {
    const cleaned = stripComments(source)
    return [
      ...collect(cleaned, /\b(?:import|export)\s+(?:type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]/),
      ...collect(cleaned, /\bimport\s*['"]([^'"]+)['"]/),
      ...collect(cleaned, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/),
      ...collect(cleaned, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/),
    ]
  },
  candidates: jsCandidates,
  configPatterns: [/(^|\/)(jest|vitest|tsconfig|package)\.[cm]?[jt]s(on)?$/],
}

// --- Python ---

const PY_ROOTS = ['src', 'lib', '.', 'app', 'tests']

const pyCandidates = (specifier: string, importer: string): string[] => {
  const parts = specifier.split('.').filter(Boolean)
  const leading = /^\.+/.exec(specifier)?.[0] ?? ''
  const relative = leading.length > 0
  const base = relative ? norm(`${dir(importer)}/${'.'.repeat(leading.length - 1)}${parts.join('/')}`) : ''
  const roots = relative ? [''] : PY_ROOTS
  return roots.flatMap((root) => {
    const prefix = root === '.' || root === '' ? '' : `${root}/`
    const target = norm(relative ? base : `${prefix}${parts.join('/')}`)
    return [`${target}.py`, `${target}/__init__.py`]
  })
}

export const python: LanguageSpec = {
  name: 'python',
  extensions: ['py', 'pyi'],
  testPattern: /(^test_.*\.py$|.*_test\.py$|(^|\/)tests?\/.*\.py$)/,
  extract: (source) => {
    const cleaned = stripComments(source)
    return [
      ...collect(cleaned, /^[ \t]*from\s+([.\w]+)\s+import\s+/m),
      ...collect(cleaned, /^[ \t]*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/m).flatMap((s) =>
        s.split(',').map((p) => p.trim()),
      ),
    ]
  },
  candidates: pyCandidates,
  configPatterns: [/(^|\/)(pyproject\.toml|setup\.cfg|pytest\.ini|tox\.ini|conftest\.py)$/],
}

// --- Rust ---

const rsCandidates = (specifier: string, importer: string): string[] => {
  const base = norm(`${dir(importer)}/${specifier}`)
  const out = [`${base}.rs`, `${base}/mod.rs`]

  const scoped = /^(?:crate|super|self)::/.test(specifier)
  if (scoped) {
    // `use crate::session::Token` names a symbol, not a module, so the tail is
    // walked up: session/Token.rs, then session.rs, which is the file that
    // actually exists.
    const tail = specifier
      .split('::')
      .filter((p) => p !== 'crate' && p !== 'super' && p !== 'self' && p !== '')
    for (let i = tail.length; i > 0; i -= 1) {
      const stem = tail.slice(0, i).join('/')
      out.push(`${dir(importer)}/${stem}.rs`, `${dir(importer)}/${stem}/mod.rs`)
    }
    // An integration test in tests/ refers to the crate root, which lives in
    // src/ or lib/ — not next to the test. Without these, every `crate::` path
    // in a test file looks unresolvable.
    for (const root of ['src', 'lib', '.']) {
      const prefix = root === '.' ? '' : `${root}/`
      for (let i = tail.length; i > 0; i -= 1) {
        const stem = `${prefix}${tail.slice(0, i).join('/')}`
        out.push(`${stem}.rs`, `${stem}/mod.rs`)
      }
    }
  }
  return [...new Set(out)]
}

export const rust: LanguageSpec = {
  name: 'rust',
  extensions: ['rs'],
  testPattern: /(^|\/)(tests?\/.*\.rs$|.*_test\.rs$)/,
  extract: (source) => {
    const cleaned = stripComments(source)
    return [
      ...collect(cleaned, /^[ \t]*(?:pub\s+)?(?:mod\s+)?mod\s+(\w+)\s*;/m),
      ...collect(cleaned, /^[ \t]*(?:pub\s+)?use\s+((?:crate|super|self)::[\w:]+|[\w]+(?:::[\w]+)+)/m),
      ...collect(cleaned, /^\s*(?:pub\s+)?mod\s+(\w+)\s*\{/m).map((m) => `mod ${m}`),
    ].filter((s) => !s.startsWith('mod '))
  },
  candidates: rsCandidates,
  configPatterns: [/(^|\/)Cargo\.(toml|lock)$/],
}

// --- Go ---

const goCandidates = (specifier: string, importer: string): string[] => {
  if (!specifier.includes('/')) return []
  // A Go import names a package, not a file, and the module prefix lives in
  // go.mod rather than in any import. The trailing segments are the best
  // available guess; anything else is resolved by the caller declaring the
  // module path internal.
  const parts = specifier.split('/')
  const out: string[] = []
  for (let take = 2; take >= 1; take -= 1) {
    const tail = parts.slice(-take).join('/')
    out.push(`${tail}.go`, `${tail}/`, tail)
  }
  const last = parts[parts.length - 1]
  out.push(`${dir(importer)}/${last}.go`, `${dir(importer)}/${last}/`)
  return [...new Set(out)]
}

export const go: LanguageSpec = {
  name: 'go',
  extensions: ['go'],
  testPattern: /_test\.go$/,
  extract: (source) => {
    const cleaned = stripComments(source)
    const block = /import\s*\(([\s\S]*?)\)/.exec(cleaned)
    const specs = [
      ...collect(cleaned, /^import\s+(?:[\w.]+\s+)?"([^"]+)"/m),
      ...(block ? collect(block[1], /^\s*(?:[\w.]+\s+)?"([^"]+)"/m) : []),
    ]
    return specs
  },
  candidates: goCandidates,
  configPatterns: [/(^|\/)go\.(mod|sum)$/],
}

// --- Java / Kotlin ---

const jvmCandidates = (specifier: string, importer: string): string[] => {
  const path = specifier.replace(/\./g, '/')
  const roots = ['src/main/java', 'src/test/java', 'src/main/kotlin', 'src', '']
  return roots.flatMap((root) => {
    const prefix = root ? `${root}/` : ''
    return [`${prefix}${path}.java`, `${prefix}${path}.kt`]
  })
}

export const java: LanguageSpec = {
  name: 'java',
  extensions: ['java', 'kt', 'kts'],
  testPattern: /(^|\/)(src\/test\/.*\.(java|kt)$|.*(Test|Tests|IT|Spec)\.(java|kt)$)/,
  extract: (source) => {
    const cleaned = stripComments(source)
    return [
      ...collect(cleaned, /^[ \t]*import\s+(?:static\s+)?([\w.]+)\s*;/m),
      ...collect(cleaned, /^[ \t]*import\s+([\w.]+\.\*)\s*;/m),
    ]
  },
  candidates: jvmCandidates,
  configPatterns: [/(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle)$/],
}

// --- Ruby ---

const rbCandidates = (specifier: string, importer: string): string[] => {
  if (specifier.startsWith('.')) {
    const base = norm(`${dir(importer)}/${specifier}`)
    return [`${base}.rb`, `${dir(importer)}/${specifier}`]
  }
  return [`lib/${specifier}.rb`, `app/${specifier}.rb`, specifier]
}

export const ruby: LanguageSpec = {
  name: 'ruby',
  extensions: ['rb'],
  testPattern: /(^|\/)(spec\/.*_spec\.rb$|test\/.*_test\.rb$)/,
  extract: (source) => {
    const cleaned = stripComments(source)
    return [
      ...collect(cleaned, /\brequire_relative\s+['"]([^'"]+)['"]/),
      ...collect(cleaned, /\brequire\s+['"]([^'"]+)['"]/),
    ]
  },
  candidates: rbCandidates,
  configPatterns: [/(^|\/)(Gemfile(\.lock)?|Rakefile|\.rspec)$/],
}

// --- C# ---

const csCandidates = (specifier: string, importer: string): string[] => {
  const path = specifier.replace(/\./g, '/')
  return [
    `${dir(importer)}/${path}.cs`,
    ...['src', 'lib'].map((root) => `${root}/${path}.cs`),
  ]
}

export const csharp: LanguageSpec = {
  name: 'csharp',
  extensions: ['cs'],
  testPattern: /(^|\/)(tests?\/.*\.cs$|.*(Test|Tests|Spec)\.cs$)/,
  extract: (source) => {
    const cleaned = stripComments(source)
    return collect(cleaned, /^[ \t]*using\s+(?:static\s+)?([\w.]+)\s*;/m)
  },
  candidates: csCandidates,
  configPatterns: [/\.csproj$/],
}

export const BUILTIN_LANGUAGES: readonly LanguageSpec[] = [
  javascript,
  python,
  rust,
  go,
  java,
  ruby,
  csharp,
]

/** Index specs by extension so a file can be routed to its language. */
export function indexLanguages(
  specs: readonly LanguageSpec[] = BUILTIN_LANGUAGES,
): Map<string, LanguageSpec> {
  const index = new Map<string, LanguageSpec>()
  for (const spec of specs) {
    for (const ext of spec.extensions) index.set(ext, spec)
  }
  return index
}

export function languageFor(
  file: string,
  index: Map<string, LanguageSpec>,
): LanguageSpec | undefined {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  return index.get(ext)
}
