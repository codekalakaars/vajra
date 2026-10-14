# The project policy: `.vajra.json`

`vajra guard` reads `.vajra.json` from the project root and uses it to decide what the confined command may read, write and delete inside the project. This page is the reference, and records why the format is what it is. The short version is in the [README](../README.md).

## The format

```json
{
  "version": 1,
  "default": { "read": true, "write": false, "delete": false },
  "paths": {
    "src/":        { "write": true },
    "migrations/": { "write": true, "delete": true },
    "secrets/":    { "read": false },
    "README.md":   { "write": true }
  }
}
```

- `version` must be `1`.
- `default` sets the rights for the whole project. Omitted fields are `read: true`, `write: false`, `delete: false`. Without a file, the default applies.
- `paths` maps project-relative paths to rights. A key ending in `/` is a folder and covers everything beneath it. A key with no trailing slash is a file. The key must match what is on disk, and must exist when the command starts.
- Each entry can set `read`, `write` and `delete`. A field it leaves out takes the value from the folder around it, or from `default`.
- The longest matching key wins: a file rule beats the folder around it, and a deeper folder beats a shallower one.
- Unknown keys are an error. So is any value that is not `true` or `false`.

## Setting rules from the command line

`vajra guard` takes the same rules as options, for one run:

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

## Why the policy is limited

The kernel enforces this with Landlock. Landlock grants add up: a right granted on a folder applies to everything beneath it, and a rule further down cannot take it back. The native layer walks the project when the command starts and gives each path its rights. That gives four limits, and the guard refuses to start rather than run looser than the file says.

1. **No `write` or `delete` at the root.** The policy file must stay read-only and undeletable, and the only way to protect a file inside a folder that allows writes is to take the right away from that file, which the kernel cannot do. So the root cannot allow them, and the command cannot create new files directly in the project root. Give write to the folders and files that need it.
2. **No taking a right away below a folder that has it.** `src/` writable with `src/gen/` not is refused. Give write to the paths that need it instead.
3. **No `delete` on a single file.** Removing a file needs delete on its folder, and that would also remove every file beside it. Put `delete` on the folder.
4. **No `"hidden": true`.** Landlock can stop a path being opened. It cannot hide the path's name from a folder listing, and `stat` still finds it. A hidden name would therefore still show, which is the opposite of what `hidden` promises. Use `"read": false`. Making a name invisible needs a mount namespace, and this Ubuntu blocks those for unprivileged users (`kernel.apparmor_restrict_unprivileged_userns`).

Two more are checked for the same reason:

- **Inside `.git`, `node_modules` and `target`.** The native walker grants these folders read and run only, and does not look inside them. A rule there would be ignored, so it is refused. Under the guard, `npm install` cannot write to `node_modules`.
- **More than eight folders deep.** The walker stops descending at that depth. A rule below it would be ignored, so it is refused.

## What the policy does not hide

- **Names.** A file with `read: false` still shows in its folder's listing, and `stat` reports its size. Only the content is protected.
- **New files.** A new file takes the rights of the folder it is created in, because the folder's grant covers it. A folder with `read: false` therefore also stops its new files being read. A file that exists when the command starts gets exactly the rule written for it.
- **Symbolic links.** A rule must name a path that is not a symbolic link. Name the file it points to, inside the project.

## Reading the dry run

`vajra guard --dry-run -- <command>` prints the rights before anything runs:

```
  rights    default: read
  rights    src/: read, write
  rights    migrations/: read, write, delete
  rights    secrets/: none
  rights    README.md: read, write
```

`none` means no right at all, which for a folder with `read: false` is still visible by name. A `--allow-write` path inside the project is reported as ignored, because the policy file decides for everything inside the project.

## Changing the design

Options for the limits above, and the reasons they are open, are in the README under "What it does not do". Making `hidden` real needs either a mount namespace (root, or a changed AppArmor setting) or a filtered view of the project through FUSE. Either is a decision, so record it here before changing the format.
