# The project policy: `.vajra.json`

`vajra` reads `.vajra.json` from the project root and uses it to decide what the confined command may read, write and delete inside the project. This page is the reference, and records why the format is what it is. The short version is in the [README](../README.md).

## The format

```json
{
  "version": 1,
  "default": { "read": true, "write": false, "delete": false },
  "paths": {
    "src/":        { "write": true },
    "migrations/": { "write": true, "delete": true },
    "secrets/":    { "read": false },
    "README.md":   { "write": true },
    "docs/":       { "create": true }
  }
}
```

- `version` must be `1`.
- `default` sets the rights for the whole project. Omitted fields are `read: true`, `write: false`, `delete: false`. Without a file, the default applies.
- `paths` maps project-relative paths to rights. A key ending in `/` is a folder and covers everything beneath it. A key with no trailing slash is a file. The key must match what is on disk, and must exist when the command starts.
- Each entry can set `read`, `write`, `delete` and `create`. `create` is for folders, and `default` can have it too, for the project root. A field it leaves out takes the value from the folder around it, or from `default`.
- The longest matching key wins: a file rule beats the folder around it, and a deeper folder beats a shallower one.
- Unknown keys are an error. So is any value that is not `true` or `false`.

## Equivalent rules

Rules are set only in `.vajra.json`. These options used to set the same rights for one run, and were removed with the `guard` command:

| Option | Rule |
|--------|------|
| `--write <path>` | `"write": true` |
| `--delete <path>` | `"delete": true` |
| `--deny-read <path>` | `"read": false` |

A path is relative to the project root, or an absolute path inside it. A path outside the project is an error. Each option is added to the file's rules for that path, and the same checks apply, so an option that the kernel cannot enforce refuses to start, the same as a line in the file would.

Options are for one run. When they are not already in `.vajra.json` (or there is no file), the guard prints the whole file that would hold them, between the line that starts `save this as` and the end of the indented block. Saving that output as `.vajra.json` gives the same rights, and the guard then has nothing left to print. The test `the JSON the guard prints, saved as the policy file, gives the same rights as the flags did` checks this.

## What each right means

| Right | On a folder | On a file |
|-------|-------------|-----------|
| `read` | List the folder, and open what is in it | Open the file |
| `write` | Create files and folders in it, and change the files already there | Change the file |
| `delete` | Remove what is directly in it. The folder itself is not removed | Not allowed on its own (see below) |
| `create` | Make new files and folders directly in it. What is already there stays read-only, and nothing can be removed or renamed. Not inherited by the folders inside. Write already includes it | Not for files |

`create` is what to give a folder (or the project root, with `"default": { "create": true }`) when the agent should add files and not touch the ones that exist. A new file can be changed for as long as the shell runs; after a restart it is an existing file and read-only, unless a `write` rule covers it.

## Why the policy is limited

The kernel enforces this with Landlock. Landlock grants add up: a right granted on a folder applies to everything beneath it, and a rule further down cannot take it back. The native layer walks the project when the command starts and gives each path its rights. That gives four limits, and the guard refuses to start rather than run looser than the file says.

1. **No `write` or `delete` at the root, but `create` is allowed.** The policy file must stay read-only and undeletable, and the only way to protect a file inside a folder that allows writes is to take the right away from that file, which the kernel cannot do. So the root cannot allow them. Give write to the folders and files that need it. `create` at the root is possible because the shell's view (`view/plan.ts`) mounts every name already in the root read-only, the policy file included, and `vajra` checks that the policy file is read-only before it applies Landlock. This is the one right that Landlock does not enforce alone: its grant covers everything beneath, and the mounts are what limit it to the new names. A `create` rule makes the guard refuse to run outside the shell's view.
2. **No taking a right away below a folder that has it.** `src/` writable with `src/gen/` not is refused. Give write to the paths that need it instead.
3. **No `delete` on a single file.** Removing a file needs delete on its folder, and that would also remove every file beside it. Put `delete` on the folder.
4. **No `"hidden": true`, and no hidden name inside a writable or create folder.** In `vajra`, `"read": false` removes the path from the shell's view, so the name is not listed either. A mount cannot hide one name in a folder that is shared with the real project and writable, so that policy is refused: hide the folder itself, or make it read-only.

Two more are checked for the same reason:

- **Inside `.git`, `node_modules` and `target`.** The native walker grants these folders read and run only, and does not look inside them. A rule there would be ignored, so it is refused. Under the guard, `npm install` cannot write to `node_modules`.
- **More than eight folders deep.** The walker stops descending at that depth. A rule below it would be ignored, so it is refused.

## What the policy does not hide

- **Names.** A file with `read: false` still shows in its folder's listing, and `stat` reports its size. Only the content is protected.
- **New files.** A new file takes the rights of the folder it is created in, because the folder's grant covers it. A folder with `read: false` therefore also stops its new files being read. A file that exists when the command starts gets exactly the rule written for it.
- **Symbolic links.** A rule must name a path that is not a symbolic link. Name the file it points to, inside the project.

## Reading the rights

`vajra doctor` reports whether the rights can be enforced on this machine. The listing below is the older dry-run output, kept as an example of the form.

```
  rights    default: read
  rights    src/: read, write
  rights    migrations/: read, write, delete
  rights    secrets/: none
  rights    README.md: read, write
```

`none` means no right at all, which for a folder with `read: false` is still visible by name. A `--allow-write` path inside the project is reported as ignored, because the policy file decides for everything inside the project.

## Changing the design

Options for the limits above, and the reasons they are open, are in the README under "What it does not do". In `vajra`, `"read": false` already hides the name, through the bubblewrap view. A separate `"hidden"` key is not needed, and the view cannot hide a name inside a writable folder. Record a change to the format here before making it.
