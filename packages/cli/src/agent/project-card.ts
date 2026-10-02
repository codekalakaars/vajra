import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How the project is built and checked, read off its manifests once per run.
 *
 * Mechanical, so every pack in a run carries the same card and no Worker spends
 * a round finding out how the tests are run. Manifests are never secret files,
 * so they are read directly rather than through a Worker's confined handle.
 */

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function packageManager(projectDir: string): string {
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(projectDir, 'bun.lockb'))) return 'bun'
  return 'npm'
}

export function buildProjectCard(projectDir: string): string {
  const lines: string[] = []

  const pkg = readJson(join(projectDir, 'package.json'))
  if (pkg) {
    const manager = packageManager(projectDir)
    const typescript = existsSync(join(projectDir, 'tsconfig.json'))
    lines.push(
      `- ${typescript ? 'TypeScript' : 'JavaScript'} (Node), ${pkg.type === 'module' ? 'ES modules' : 'CommonJS'}, ${manager}`,
    )
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, unknown>
    for (const name of ['test', 'build', 'lint', 'typecheck']) {
      const script = scripts[name]
      if (typeof script === 'string') lines.push(`- ${name}: \`${script}\` (${manager} run ${name})`)
    }
    const deps = {
      ...((pkg.dependencies as Record<string, unknown>) ?? {}),
      ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
    }
    const names = Object.keys(deps)
    lines.push(names.length === 0 ? '- No npm dependencies: only Node built-ins are available' : `- Dependencies: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}`)
  }
  if (existsSync(join(projectDir, 'Cargo.toml'))) lines.push('- Rust (Cargo): `cargo check`, `cargo test`')
  if (existsSync(join(projectDir, 'go.mod'))) lines.push('- Go: `go build ./...`, `go test ./...`')
  if (existsSync(join(projectDir, 'pyproject.toml')) || existsSync(join(projectDir, 'requirements.txt'))) {
    lines.push('- Python: `python -m compileall .`, `pytest`')
  }
  if (existsSync(join(projectDir, 'pom.xml'))) lines.push('- Java (Maven): `mvn -q compile`, `mvn -q test`')
  if (existsSync(join(projectDir, 'build.gradle')) || existsSync(join(projectDir, 'build.gradle.kts'))) {
    lines.push('- Java (Gradle): `gradle compileJava`, `gradle test`')
  }

  return lines.length > 0 ? lines.join('\n') : '- No manifest found: read the files you are given to see how the code runs'
}
