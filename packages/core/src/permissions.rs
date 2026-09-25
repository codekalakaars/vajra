use napi::Error;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
    pub default: FilePermissions,
    pub files: HashMap<String, FilePermissions>,
}

#[napi(object)]
pub struct ProjectFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_masked: bool,
}

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

const PUBLIC_ENV_SUFFIXES: &[&str] = &[
    "example", "sample", "template", "defaults", "default", "dist",
];

fn is_masked(name: &str) -> bool {
    if name == ".env" {
        return true;
    }
    let Some(rest) = name.strip_prefix(".env.") else {
        return false;
    };
    !rest.split('.').any(|segment| {
        PUBLIC_ENV_SUFFIXES
            .iter()
            .any(|public| public.eq_ignore_ascii_case(segment))
    })
}

#[napi]
pub fn default_permissions() -> PermissionsConfig {
    default_config()
}

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

pub fn effective(config: &PermissionsConfig, path: &str) -> FilePermissions {
    config.files.get(path).cloned().unwrap_or_else(|| config.default.clone())
}

#[napi]
pub fn permissions_for(config: PermissionsConfig, path: String) -> FilePermissions {
    effective(&config, &path)
}

#[napi]
pub fn scan_project(project_dir: String) -> Result<Vec<ProjectFileEntry>, Error> {
    let root = PathBuf::from(&project_dir);
    let mut entries = Vec::new();
    let mut stack: Vec<(PathBuf, u32)> = vec![(root.clone(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
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
            FilePermissions { read: true, write: true, edit: true, delete: false },
        );
        save_permissions(dir.to_string_lossy().to_string(), config).unwrap();
        let loaded = load_permissions(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(loaded.version, 1);
        let entry = loaded.files.get("src/main.rs").unwrap();
        assert!(entry.write);
        assert!(!entry.delete);
    }

    #[test]
    fn reads_the_on_disk_format() {
        let dir = scratch("on-disk-format");
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
            FilePermissions { read: true, write: true, edit: false, delete: false },
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
        assert!(names.contains(&"index.js"));
        assert!(!names.contains(&".hidden"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&"pkg"));

        let env = entries.iter().find(|e| e.name == ".env").unwrap();
        assert!(env.is_masked);
        assert!(is_masked(".env.local"));
        assert!(is_masked(".env.production"));
        assert!(is_masked(".env.development"));
        assert!(!is_masked(".env.example"));
        assert!(!is_masked(".env.sample"));
        assert!(!entries.iter().find(|e| e.name == "app.js").unwrap().is_masked);
    }

    #[test]
    fn scan_uses_relative_forward_slashed_paths() {
        let dir = scratch("relpaths");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/index.js"), "").unwrap();
        let entries = scan_project(dir.to_string_lossy().to_string()).unwrap();
        let nested = entries.iter().find(|e| e.name == "index.js").unwrap();
        assert_eq!(nested.path, "src/index.js");
    }

    #[test]
    fn scan_reports_a_missing_project_dir() {
        let missing = std::env::temp_dir().join("vajra-perms-definitely-absent");
        assert!(scan_project(missing.to_string_lossy().to_string()).is_err());
    }
}
