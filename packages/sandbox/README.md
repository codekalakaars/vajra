# @codekalakaars/vajra-sandbox

The policy and the guards a confined shell is built from. The native addon (`packages/native`) does the confining with Landlock; this package decides what to confine and keeps the records around it.

**Not the guard's policy file.** `vajra guard` reads `.vajra.json` at the project root, with its own format (see `docs/project-policy.md`). The glob rules and `.vajra-sandbox.json` below are this package's API. Nothing in `vajra guard` calls them yet.

**Linux only.** Landlock is a Linux kernel feature; `platform-guard` refuses to start anywhere else.

## What is in it

| File | What |
|------|------|
| `config.ts` | `createSandboxConfig`: an immutable description of what a confined process may touch (file rules, extra read and write paths) |
| `file-rules.ts` | Glob rules (`*`, `**`, `?`, `!` to revoke) resolved to the per-file permissions the addon enforces |
| `file-config.ts` | Reading and writing `.vajra-sandbox.json`, flat or as named environments (not read by `vajra guard`) |
| `platform.ts`, `platform-guard.ts` | The Linux-only check, and an import that stops a command early with the real reason |
| `native.ts` | The addon wrapper: capabilities, Landlock, seccomp, secret masking, and process helpers |
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

## Live virtual filesystem view

`VirtualFileSystem` gives an agent a mediated view whose default is deny-all.
Only files matching the configured read patterns appear in listings, and a
directory appears only when it contains a visible file. Reads and mutations
check the current policy on every call. The controller can replace the allowlist
while the agent is running; the next call sees the new policy.

```typescript
import { createVirtualFileSystem, createSandboxConfig } from '@codekalakaars/vajra-sandbox'

const vfs = createVirtualFileSystem(projectDir, ['src/**', 'README.md'])
const agentFilesystem = vfs.view

// Optional: changes saved to .vajra-sandbox.json are loaded while it runs.
const stopWatchingConfig = vfs.watchConfig()

// Give the agent only agentFilesystem, never the host fs module or controller.
const files = agentFilesystem.list()
const source = agentFilesystem.readFile('src/index.ts')

// A trusted controller can change visibility immediately.
vfs.setVisiblePaths(['src/**', 'docs/**'])

// Use updateConfig when the agent also needs write permissions.
vfs.updateConfig(createSandboxConfig({
  projectDir,
  defaultPermissions: { read: false, write: false, edit: false, delete: false },
  fileRules: [
    { pattern: 'src/**', read: true, write: true, edit: true },
    { pattern: 'docs/**', read: true },
  ],
}))

stopWatchingConfig()
```

If the watched config is missing, invalid, or cannot be reloaded, the VFS
switches to deny-all until a valid policy is saved.

`VirtualFileSystem` is an API mediation layer for in-process callers. It is not
an OS sandbox, and the `vajra` shell does not use it: the shell is confined by
bubblewrap, Landlock and seccomp (see the repository README).

## Tests

```bash
pnpm --filter @codekalakaars/vajra-sandbox test   # builds are separate: run pnpm build:all first
```
