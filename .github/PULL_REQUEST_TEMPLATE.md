## Description

Briefly describe the change.

## Related Issue

Closes #...

## Checklist

- [ ] `cargo clippy --all-targets -- -D warnings` passes
- [ ] `cargo test` passes
- [ ] `pnpm build && pnpm test` passes
- [ ] Regenerated `index.js` / `index.d.ts` are committed, if bindings changed
- [ ] Works on Linux, macOS and Windows (CI matrix is green)
- [ ] Commit messages follow Conventional Commits
