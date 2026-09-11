# @codekalakaars/vajra-sandbox

Programmatically configurable sandbox policy for Vajra. Restricts what files a worker can access and what tools it can call.

## Install

```bash
pnpm add @codekalakaars/vajra-sandbox
```

## Usage

### Programmatic API

```typescript
import { createSandboxConfig, resolveAllowedTools, buildLaunchJob } from '@codekalakaars/vajra-sandbox'

const config = createSandboxConfig({
  projectDir: '/path/to/project',
  defaultPermissions: { read: true, write: false, edit: false, delete: false },
  fileRules: [
    { pattern: 'src/**', write: true },
    { pattern: '.env', read: false },
  ],
  allowedTools: ['read_file', 'write_file', 'edit_file'],
})

const tools = resolveAllowedTools(config, 'worker')
const job = buildLaunchJob(config, 'session-1')
```

### CLI

```bash
# Check sandbox capabilities
vajra status

# Create or view .vajra-sandbox.json
vajra config

# Test if sandbox works on this platform
vajra test

# Apply sandbox and run a command inside it
vajra secure -- npm test
vajra secure -- node server.js
```

**Examples:**

```
$ vajra status

Vajra — capabilities

  Platform:   linux
  Filesystem: enforced
  Mechanism:  landlock
  Details:    Landlock ABI 4: all filesystem restrictions enforced

  ✅ Full sandbox enforcement available.
```

```
$ vajra config --project-dir ./my-app

Created: ./my-app/.vajra-sandbox.json

Default configuration:
  - Read: allowed
  - Write: denied
  - Edit: denied
  - Delete: denied

Edit .vajra-sandbox.json to customize permissions.
```

```
$ vajra secure --project-dir ./my-app -- npm test

🔒 Secured: landlock (enforced)
   Project: ./my-app

   ... tests run here, confined to ./my-app ...
```

## Architecture

- **config.ts** — Immutable sandbox config builder
- **file-rules.ts** — Glob-based file permission resolution (`*`, `**`, `?`, `!` negation)
- **tool-rules.ts** — Tool allowlisting with role-based defaults
- **sandbox-builder.ts** — Translates config to `LaunchJob` for the worker
- **file-config.ts** — Load/save `.vajra-sandbox.json` (flat and named environments)
- **file-locks.ts** — Read-shared/write-exclusive file locking
- **resources.ts** — Per-worker resource limits (memory, CPU, tool calls)
- **cli.ts** — `vajra-sandbox` CLI tool

## Testing

```bash
pnpm test
```
