// Cross-platform stand-in for `mkdir -p dist/db && cp src/db/schema.sql dist/db/schema.sql`.
// `cp`/`mkdir -p` are Unix-only; this project's build has to work on Windows too.
import { mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'dist', 'db', 'schema.sql')

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(join(root, 'src', 'db', 'schema.sql'), dest)
