//! Per-file permission config: what an agent may do to each path in a project.
//!
//! Ported from the legacy CLI (`legacy/src/permissions.rs`). The config format
//! (`.vajra-perms.json`) is unchanged, so a file written by the old CLI still
//! loads here.
//!
//! Nothing in this module enforces anything — it is the declaration that a
//! sandbox layer consumes. Enforcement is Phase 3.

use napi::Error;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Matches the walk depth used by `file::list_files` and the legacy Landlock
/// rules, so what the config describes and what gets enforced agree.
const MAX_DEPTH: u32 = 8;

const CONFIG_FILE: &str = ".vajra-perms.json";

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePermissions {
    pub read: bool,
    pub write: bool,
    pub edit: bool,
    pub delete: bool,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionsConfig {
    pub version: u8,
    /// Applied to any path without an entry in `files`.
    pub default: FilePermissions,
    /// Per-path overrides, keyed by project-relative path with `/` separators.
    pub files: HashMap<String, FilePermissions>,
}

#[napi(object)]
pub struct ProjectFileEntry {
    pub name: String,
    /// Project-relative, always `/`-separated so a config written on one
    /// platform still resolves on another.
    pub path: String,
    pub is_dir: bool,
    /// True for env files whose contents the agent must not see.
    pub is_masked: bool,
}

/// Read-only by default. A permission model that opens with write access is not
/// a permission model, so anything beyond reading has to be granted explicitly.
pub fn default_config() -> PermissionsConfig {
    PermissionsConfig {
        version: 1,
        default: FilePermissions {
            read: true,
            write: false,
            edit: false,
            delete: false,
        },
        files: HashMap::new(),
    }
}

fn should_skip_dir(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target")
}

/// Env files are listed but their contents are masked from the agent.
fn is_masked(name: &str) -> bool {
    name == ".env" || name == ".env.local"
}

#[napi]
pub fn default_permissions() -> PermissionsConfig {
    default_config()
}

/// Load `.vajra-perms.json` from a project. Returns null when absent or
/// unparseable, so a corrupt file falls back to the safe default rather than
/// failing the caller.
#[napi]
pub fn load_permissions(project_dir: String) -> Option<PermissionsConfig> {
    let path = Path::new(&project_dir).join(CONFIG_FILE);
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

#[napi]
pub fn save_permissions(project_dir: String, config: PermissionsConfig) -> Result<(), Error> {
    let path = Path::new(&project_dir).join(CONFIG_FILE);

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| Error::from_reason(format!("Failed to serialize permissions: {}", e)))?;

    std::fs::write(&path, content)
        .map_err(|e| Error::from_reason(format!("Failed to write '{}': {}", path.display(), e)))
}

/// Resolve the effective permissions for a project-relative path.
pub fn effective(config: &PermissionsConfig, path: &str) -> FilePermissions {
    config
        .files
        .get(path)
        .cloned()
        .unwrap_or_else(|| config.default.clone())
}

/// Resolve the effective permissions for a project-relative path.
///
/// Takes the config by value: napi object types cross the boundary as data, not
/// as a reference to a live JS object.
#[napi]
pub fn permissions_for(config: PermissionsConfig, path: String) -> FilePermissions {
    effective(&config, &path)
}

/// List the project's files as permission targets.
///
/// Returns a flat list rather than a nested tree: it keeps the binding free of
/// a self-referential type, and a caller that wants a tree can rebuild one from
/// the relative paths.
///
/// Skips `.git`, `node_modules` and `target`, and hidden files other than
/// `.sample.env`. Symlinks are never followed and depth is capped, for the same
/// reason as `file::list_files` — a link to an ancestor would otherwise recurse
/// without end.
#[napi]
pub fn scan_project(project_dir: String) -> Result<Vec<ProjectFileEntry>, Error> {
    let root = PathBuf::from(&project_dir);
    let mut entries = Vec::new();
    let mut stack: Vec<(PathBuf, u32)> = vec![(root.clone(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            // An unreadable subdirectory should not abort the whole scan; the
            // caller still gets everything else.
            Err(_) if dir != root => continue,
            Err(e) => {
                return Err(Error::from_reason(format!(
                    "Failed to read directory '{}': {}",
                    dir.display(),
                    e
                )))
            }
        };

        for entry in read_dir.flatten() {
            let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };

            if name.starts_with('.') && name != ".sample.env" && !is_masked(&name) {
                continue;
            }

            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            let rel_path = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");

            let is_dir = file_type.is_dir();
            if is_dir {
                if should_skip_dir(&name) {
                    continue;
                }
                if depth < MAX_DEPTH {
                    stack.push((path.clone(), depth + 1));
                }
            }

            entries.push(ProjectFileEntry {
                is_masked: !is_dir && is_masked(&name),
                name,
                path: rel_path,
                is_dir,
            });
        }
    }

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.path.cmp(&b.path)));

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vajra-perms-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn default_is_read_only() {
        let config = default_config();
        assert!(config.default.read);
        assert!(!config.default.write);
        assert!(!config.default.edit);
        assert!(!config.default.delete);
        assert!(config.files.is_empty());
    }

    #[test]
    fn config_round_trips_through_disk() {
        let dir = scratch("roundtrip");
        let mut config = default_config();
        config.files.insert(
            "src/main.rs".into(),
            FilePermissions {
                read: true,
                write: true,
                edit: true,
                delete: false,
            },
        );

        save_permissions(dir.to_string_lossy().to_string(), config).unwrap();
        let loaded = load_permissions(dir.to_string_lossy().to_string()).unwrap();

        assert_eq!(loaded.version, 1);
        let entry = loaded.files.get("src/main.rs").unwrap();
        assert!(entry.write);
        assert!(!entry.delete);
    }

    #[test]
    fn reads_the_legacy_on_disk_format() {
        // A file written by the old CLI must still load.
        let dir = scratch("legacy-format");
        std::fs::write(
            dir.join(CONFIG_FILE),
            r#"{"version":1,"default":{"read":true,"write":false,"edit":false,"delete":false},"files":{}}"#,
        )
        .unwrap();

        let loaded = load_permissions(dir.to_string_lossy().to_string()).unwrap();
        assert!(loaded.default.read);
    }

    #[test]
    fn missing_or_corrupt_config_is_none() {
        let dir = scratch("corrupt");
        assert!(load_permissions(dir.to_string_lossy().to_string()).is_none());

        std::fs::write(dir.join(CONFIG_FILE), "{not json").unwrap();
        assert!(load_permissions(dir.to_string_lossy().to_string()).is_none());
    }

    #[test]
    fn lookup_falls_back_to_the_default() {
        let mut config = default_config();
        config.files.insert(
            "granted.txt".into(),
            FilePermissions {
                read: true,
                write: true,
                edit: false,
                delete: false,
            },
        );

        assert!(effective(&config, "granted.txt").write);
        assert!(!effective(&config, "other.txt").write);
        assert!(effective(&config, "other.txt").read);
    }

    #[test]
    fn scan_skips_noise_and_flags_masked_env_files() {
        let dir = scratch("scan");
        std::fs::write(dir.join("app.js"), "").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=x").unwrap();
        std::fs::write(dir.join(".sample.env"), "SECRET=").unwrap();
        std::fs::write(dir.join(".hidden"), "").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/index.js"), "").unwrap();

        let entries = scan_project(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert!(names.contains(&"app.js"));
        assert!(names.contains(&".sample.env"));
        assert!(names.contains(&"index.js"), "should descend into src/");
        assert!(!names.contains(&".hidden"), "hidden files are skipped");
        assert!(!names.contains(&"node_modules"), "noise dirs are skipped");
        assert!(!names.contains(&"pkg"), "must not descend into node_modules");

        let env = entries.iter().find(|e| e.name == ".env").unwrap();
        assert!(env.is_masked, ".env must be flagged as masked");
        assert!(!entries.iter().find(|e| e.name == "app.js").unwrap().is_masked);
    }

    #[test]
    fn scan_uses_relative_forward_slashed_paths() {
        let dir = scratch("relpaths");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/index.js"), "").unwrap();

        let entries = scan_project(dir.to_string_lossy().to_string()).unwrap();
        let nested = entries.iter().find(|e| e.name == "index.js").unwrap();

        // Config keys must be portable across platforms.
        assert_eq!(nested.path, "src/index.js");
    }

    #[test]
    fn scan_reports_a_missing_project_dir() {
        let missing = std::env::temp_dir().join("vajra-perms-definitely-absent");
        assert!(scan_project(missing.to_string_lossy().to_string()).is_err());
    }
}
