use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePermissions {
    pub read: bool,
    pub write: bool,
    pub edit: bool,
    pub delete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionsConfig {
    pub version: u8,
    pub default: FilePermissions,
    pub files: HashMap<String, FilePermissions>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileEntry>,
    pub is_masked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileTree {
    pub name: String,
    pub children: Vec<FileEntry>,
}

const CONFIG_FILE: &str = ".vajra-perms.json";

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

pub fn load(project_dir: &Path) -> Option<PermissionsConfig> {
    let path = project_dir.join(CONFIG_FILE);
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save(project_dir: &Path, config: &PermissionsConfig) -> Result<(), String> {
    let path = project_dir.join(CONFIG_FILE);
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("serialize permissions: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("write {}: {}", path.display(), e))
}

fn should_skip_dir(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target")
}

fn is_masked(name: &str) -> bool {
    name == ".env" || name == ".env.local"
}

pub fn scan_tree(project_dir: &Path) -> Result<FileTree, String> {
    let name = project_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("project")
        .to_string();

    let children = scan_dir(project_dir, project_dir, 0)?;

    Ok(FileTree { name, children })
}

fn scan_dir(root: &Path, dir: &Path, depth: u32) -> Result<Vec<FileEntry>, String> {
    if depth > 8 {
        return Ok(vec![]);
    }

    let mut entries = Vec::new();
    let mut dir_stream =
        std::fs::read_dir(dir).map_err(|e| format!("read dir {}: {}", dir.display(), e))?;

    while let Some(entry) = dir_stream.next().transpose().ok().flatten() {
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };

        if name.starts_with('.') && name != ".sample.env" {
            continue;
        }

        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        let path = entry.path();
        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string()
            .replace('\\', "/");

        if ft.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            let children = scan_dir(root, &path, depth + 1)?;
            entries.push(FileEntry {
                name,
                path: rel_path,
                is_dir: true,
                children,
                is_masked: false,
            });
        } else if ft.is_file() {
            let masked = is_masked(&name);
            entries.push(FileEntry {
                name,
                path: rel_path,
                is_dir: false,
                children: vec![],
                is_masked: masked,
            });
        }
    }

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));

    Ok(entries)
}
