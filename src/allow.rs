//! Extra paths for the sandbox beyond the project dir: user-supplied --allow
//! / --allow-rw dirs plus auto-detected toolchain install prefixes (node/npm
//! under ~/.nvm, opencode under ~/.opencode, ...) and agent state dirs
//! (~/.local/share/opencode, ...) that live outside the default system paths.

use std::path::{Path, PathBuf};

/// Binaries whose install prefixes are allowed automatically (read+execute)
/// when found on PATH. Node tooling and common AI CLI agents.
const AUTO_TOOLS: &[&str] = &["node", "npm", "npx", "opencode", "claude", "codex"];

/// AI CLI agents that keep writable state (logs, auth, session history)
/// under dirs named after themselves in $HOME. Node/npm don't need this.
const STATEFUL_AGENTS: &[&str] = &["opencode", "claude", "codex"];

/// Extra sandbox paths, split by the access they need.
pub struct AllowedPaths {
    /// Read + execute (toolchain install dirs, plain --allow).
    pub rx: Vec<String>,
    /// Read + write, no execute (agent state dirs, --allow-rw).
    pub rw: Vec<String>,
}

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

/// Candidate state dirs a CLI tool might use under a home directory, checked
/// for existence — only dirs that are actually there get allowed.
fn candidate_state_dirs(home: &Path, tool: &str) -> Vec<PathBuf> {
    vec![
        home.join(".local/share").join(tool),
        home.join(".config").join(tool),
        home.join(".cache").join(tool),
        home.join(format!(".{}", tool)),
    ]
}

/// Auto-detect writable state dirs for AI agents found on PATH (logs, auth,
/// session history) — these need read+write, not execute.
pub fn detect_agent_state_dirs() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    for tool in STATEFUL_AGENTS {
        if find_on_path(tool).is_none() {
            continue;
        }
        for candidate in candidate_state_dirs(&home, tool) {
            if !candidate.is_dir() {
                continue;
            }
            let path = candidate.to_string_lossy().to_string();
            if !dirs.contains(&path) {
                dirs.push(path);
            }
        }
    }
    dirs
}

fn canonicalize_existing(dir: &str, flag: &str) -> Option<String> {
    let canonical = std::fs::canonicalize(dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| dir.to_string());
    if !Path::new(&canonical).exists() {
        eprintln!("vajra: {} {}: path does not exist, skipping", flag, dir);
        return None;
    }
    Some(canonical)
}

/// Merge user --allow / --allow-rw dirs with auto-detected ones, deduplicated
/// within each list, existing paths only.
pub fn collect(user_allowed: &[String], user_allowed_rw: &[String]) -> AllowedPaths {
    let mut rx = detect_toolchain_dirs();
    for dir in user_allowed {
        if let Some(canonical) = canonicalize_existing(dir, "--allow")
            && !rx.contains(&canonical)
        {
            rx.push(canonical);
        }
    }

    let mut rw = detect_agent_state_dirs();
    for dir in user_allowed_rw {
        if let Some(canonical) = canonicalize_existing(dir, "--allow-rw")
            && !rw.contains(&canonical)
        {
            rw.push(canonical);
        }
    }

    AllowedPaths { rx, rw }
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

    #[test]
    fn candidate_dirs_cover_common_state_locations() {
        let home = Path::new("/home/u");
        let candidates = candidate_state_dirs(home, "opencode");
        assert!(candidates.contains(&PathBuf::from("/home/u/.local/share/opencode")));
        assert!(candidates.contains(&PathBuf::from("/home/u/.config/opencode")));
        assert!(candidates.contains(&PathBuf::from("/home/u/.cache/opencode")));
        assert!(candidates.contains(&PathBuf::from("/home/u/.opencode")));
    }

    #[test]
    fn only_existing_state_dirs_are_allowed() {
        let dir = std::env::temp_dir().join(format!("vajra-allow-test-{}", std::process::id()));
        let fake_home = dir.join("home");
        std::fs::create_dir_all(fake_home.join(".local/share/opencode")).unwrap();
        // .config/opencode intentionally not created.

        let candidates = candidate_state_dirs(&fake_home, "opencode");
        let existing: Vec<_> = candidates.iter().filter(|p| p.is_dir()).collect();
        assert_eq!(existing.len(), 1);
        assert!(existing[0].ends_with(".local/share/opencode"));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
