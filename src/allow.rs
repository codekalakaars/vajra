//! Extra read+execute paths for the sandbox: user-supplied --allow dirs plus
//! auto-detected toolchain install prefixes (node/npm under ~/.nvm, opencode
//! under ~/.opencode, ...) that live outside the default system paths.

use std::path::{Path, PathBuf};

/// Binaries whose install prefixes are allowed automatically when found on
/// PATH. Node tooling and common AI CLI agents.
const AUTO_TOOLS: &[&str] = &["node", "npm", "npx", "opencode", "claude", "codex"];

fn find_on_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|candidate| candidate.is_file())
}

/// The directory to allow for a resolved binary: its install prefix rather
/// than just the bin dir, so sibling `lib/` trees (npm's node_modules) work.
fn install_prefix(resolved_bin: &Path) -> Option<PathBuf> {
    let bin_dir = resolved_bin.parent()?;
    if bin_dir.file_name().is_some_and(|n| n == "bin") {
        bin_dir.parent().map(Path::to_path_buf)
    } else {
        Some(bin_dir.to_path_buf())
    }
}

/// Roots that are already reachable via the default Landlock rules; allowing
/// them again would be redundant noise.
fn covered_by_defaults(dir: &Path) -> bool {
    ["/usr", "/lib", "/lib64", "/bin", "/sbin"]
        .iter()
        .any(|root| dir.starts_with(root))
}

/// Auto-detect toolchain install prefixes worth allowing inside the sandbox.
pub fn detect_toolchain_dirs() -> Vec<String> {
    let mut dirs = Vec::new();
    for tool in AUTO_TOOLS {
        let Some(found) = find_on_path(tool) else { continue };
        let resolved = std::fs::canonicalize(&found).unwrap_or(found);
        let Some(prefix) = install_prefix(&resolved) else { continue };
        if covered_by_defaults(&prefix) {
            continue;
        }
        let prefix = prefix.to_string_lossy().to_string();
        if !dirs.contains(&prefix) {
            dirs.push(prefix);
        }
    }
    dirs
}

/// Merge user --allow dirs with auto-detected ones, deduplicated, existing only.
pub fn collect(user_allowed: &[String]) -> Vec<String> {
    let mut dirs = detect_toolchain_dirs();
    for dir in user_allowed {
        let canonical = std::fs::canonicalize(dir)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| dir.clone());
        if !Path::new(&canonical).exists() {
            eprintln!("vajra: --allow {}: path does not exist, skipping", dir);
            continue;
        }
        if !dirs.contains(&canonical) {
            dirs.push(canonical);
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_of_bin_dir_is_grandparent() {
        assert_eq!(
            install_prefix(Path::new("/home/u/.nvm/versions/node/v24.0.0/bin/node")),
            Some(PathBuf::from("/home/u/.nvm/versions/node/v24.0.0"))
        );
    }

    #[test]
    fn prefix_of_plain_dir_is_parent() {
        assert_eq!(
            install_prefix(Path::new("/opt/tools/mytool")),
            Some(PathBuf::from("/opt/tools"))
        );
    }

    #[test]
    fn default_roots_are_skipped() {
        assert!(covered_by_defaults(Path::new("/usr/local")));
        assert!(covered_by_defaults(Path::new("/bin")));
        assert!(!covered_by_defaults(Path::new("/home/u/.nvm")));
        assert!(!covered_by_defaults(Path::new("/opt/tools")));
    }
}
