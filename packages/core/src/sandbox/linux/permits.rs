use crate::permissions::{effective, FilePermissions, PermissionsConfig};
use crate::sandbox::MAX_DEPTH;
use std::path::Path;

use super::syscall::{access, add_path_rule};

/// Which rights have at least one per-path override stricter than the default.
///
/// Landlock rules are additive: a directory grant applies recursively and no
/// narrower descendant rule can revoke it. When a right is narrowed, directory
/// rules withhold it and rely on each path's own explicit rule instead.
#[derive(Default)]
pub struct Narrowed {
    pub read: bool,
    pub delete: bool,
}

impl Narrowed {
    pub fn detect(perms: &PermissionsConfig) -> Self {
        let mut n = Narrowed::default();
        for file_perm in perms.files.values() {
            n.read |= perms.default.read && !file_perm.read;
            n.delete |= perms.default.delete && !file_perm.delete;
        }
        n
    }

    pub fn any(&self) -> bool {
        self.read || self.delete
    }
}

pub fn perms_to_bits(perm: &FilePermissions, is_dir: bool, supported: u64, narrowed: &Narrowed) -> u64 {
    let mut bits = access::EXECUTE;

    if perm.read {
        bits |= access::READ_DIR;
        if !(is_dir && narrowed.read) {
            bits |= access::READ_FILE;
        }
    }

    if is_dir {
        if perm.write {
            bits |= access::MAKE_DIR | access::MAKE_REG | access::MAKE_SYM;
        }
        if perm.delete && !narrowed.delete {
            bits |= access::REMOVE_DIR | access::REMOVE_FILE;
        }
    } else {
        if perm.write {
            bits |= access::WRITE_FILE | access::MAKE_REG;
        }
        if perm.edit {
            bits |= access::TRUNCATE;
        }
        if perm.delete {
            bits |= access::REMOVE_FILE;
        }
    }

    bits & supported
}

pub(crate) fn should_skip_dir(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target")
}

pub(crate) fn apply_per_file_rules(
    ruleset_fd: i32,
    project_dir: &Path,
    perms: &PermissionsConfig,
    supported: u64,
    notes: &mut Vec<String>,
) -> Result<(), String> {
    let narrowed = Narrowed::detect(perms);
    if narrowed.any() {
        notes.push(
            "a per-file rule narrows read or delete below the project default; paths created \
             after this sandbox is applied will not automatically inherit that right"
                .into(),
        );
    }

    let root_bits = perms_to_bits(&perms.default, true, supported, &narrowed);
    add_path_rule(ruleset_fd, &project_dir.to_string_lossy(), root_bits)?;

    let mut stack: Vec<(std::path::PathBuf, u32)> = vec![(project_dir.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in read_dir.flatten() {
            let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };

            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            let rel = path
                .strip_prefix(project_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");

            let is_dir = file_type.is_dir();
            if is_dir && should_skip_dir(&name) {
                continue;
            }

            let perm = effective(perms, &rel);
            let bits = perms_to_bits(&perm, is_dir, supported, &narrowed);

            let _ = add_path_rule(ruleset_fd, &path.to_string_lossy(), bits);

            if is_dir && depth < MAX_DEPTH {
                stack.push((path, depth + 1));
            }
        }
    }

    Ok(())
}
