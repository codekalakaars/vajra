// Cross-platform stand-in for `mkdir -p dist/db && cp src/db/schema.sql dist/db/schema.sql`.
// `cp`/`mkdir -p` are Unix-only; this project's build has to work on Windows too.
import { mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'dist', 'db', 'schema.sql')

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(join(root, 'src', 'db', 'schema.sql'), dest)

// Copy migrations directory
const migrationsSrc = join(root, 'src', 'db', 'migrations')
const migrationsDest = join(root, 'dist', 'db', 'migrations')
if (existsSync(migrationsSrc)) {
  mkdirSync(migrationsDest, { recursive: true })
  for (const file of readdirSync(migrationsSrc)) {
    copyFileSync(join(migrationsSrc, file), join(migrationsDest, file))
  }
}
