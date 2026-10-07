# @codekalakaars/vajra-sandbox

The policy and the guards a confined shell is built from. The native addon (`packages/native`) does the confining with Landlock; this package decides what to confine and keeps the records around it.

**Linux only.** Landlock is a Linux kernel feature; `platform-guard` refuses to start anywhere else.

## What is in it

| File | What |
|------|------|
| `config.ts` | `createSandboxConfig`: an immutable description of what a confined process may touch (file rules, extra read and write paths) |
| `file-rules.ts` | Glob rules (`*`, `**`, `?`, `!` to revoke) resolved to the per-file permissions the addon enforces |
| `file-config.ts` | Reading and writing `.vajra-sandbox.json`, flat or as named environments |
| `platform.ts`, `platform-guard.ts` | The Linux-only check, and an import that stops a command early with the real reason |
| `native.ts` | The addon wrapper: capabilities, `applySandbox`, secret masking (`.env` and variants), `redact`, running a command with a deadline |
| `change-history.ts` | The original of each file before it is modified, so changes can be rolled back |
| `freeze.ts` | Freeze and thaw a process and everything it started (`SIGSTOP` and `SIGCONT` down the tree) |
| `types.ts` | Permission and file-entry shapes |

## Example

```typescript
import { createSandboxConfig, resolveFilePermissions } from '@codekalakaars/vajra-sandbox'

const config = createSandboxConfig({
  projectDir: '/path/to/project',
  defaultPermissions: { read: true, write: false, edit: false, delete: false },
  fileRules: [
    { pattern: 'src/**', write: true },
    { pattern: '.env', read: false },
  ],
})

const permissions = resolveFilePermissions(config) // what the addon enforces
```

## Tests

```bash
pnpm --filter @codekalakaars/vajra-sandbox test   # builds are separate: run pnpm build:all first
```
