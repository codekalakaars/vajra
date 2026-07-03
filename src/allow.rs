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
/// for existence — only dirs that are actually there get allowed. Follows
/// the XDG base dirs (data/config/cache/state) plus the common non-XDG
/// `~/.<tool>` convention; opencode specifically keeps file locks under
/// `$XDG_STATE_HOME/opencode`, distinct from its data/config/cache dirs.
fn candidate_state_dirs(home: &Path, tool: &str) -> Vec<PathBuf> {
    vec![
        home.join(".local/share").join(tool),
        home.join(".config").join(tool),
        home.join(".cache").join(tool),
        home.join(".local/state").join(tool),
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

/// git config paths worth exposing read-only so git works inside the sandbox
/// (coding agents run `git status`/`log`/`commit`, and opencode specifically
/// resolves its per-project session id via `git rev-parse`, which git refuses
/// to run at all — "detected dubious ownership" — unless a `safe.directory`
/// exception in a *readable* config file covers the repo). Deliberately
/// excludes `~/.git-credentials`: plaintext stored tokens are more sensitive
/// than an API key, so that one stays opt-in via `--allow`.
fn git_config_candidates(home: &Path, config_home: &Path) -> Vec<PathBuf> {
    vec![home.join(".gitconfig"), config_home.join("git")]
}

pub fn detect_git_config_paths() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));

    git_config_candidates(&home, &config_home)
        .into_iter()
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

/// Env vars carrying an AI agent's *own* credentials or behavior flags —
/// distinct from a project's `.env` secrets. Sandboxed shells strip the host
/// environment to protect project secrets, but that also strips the
/// developer's own LLM API keys, which the agent legitimately needs to
/// function. This is a bounded, explicit list (not "anything named
/// *_API_KEY") so passthrough stays a deliberate choice, not a blanket leak
/// of whatever happens to be in the host shell.
pub const AGENT_ENV_PASSTHROUGH: &[&str] = &[
    // opencode / generic agent behavior + auth
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_TUI_CONFIG",
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_MODELS_URL",
    "OPENCODE_MODELS_PATH",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_MODELS_FETCH",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_DISABLE_PRUNE",
    "OPENCODE_DB",
    // Common LLM providers
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "NVIDIA_API_KEY",
    "DIGITALOCEAN_ACCESS_TOKEN",
    // AWS Bedrock
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    // Azure
    "AZURE_RESOURCE_NAME",
    "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
    // Google Vertex
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "VERTEX_LOCATION",
    // Cloudflare AI Gateway
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_GATEWAY_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    // GitLab Duo
    "GITLAB_TOKEN",
    "GITLAB_INSTANCE_URL",
    "GITLAB_AI_GATEWAY_URL",
    "GITLAB_OAUTH_CLIENT_ID",
    // Snowflake Cortex
    "SNOWFLAKE_ACCOUNT",
    "SNOWFLAKE_CORTEX_TOKEN",
    "SNOWFLAKE_CORTEX_PAT",
    // SAP AI Core
    "AICORE_SERVICE_KEY",
    "AICORE_DEPLOYMENT_ID",
    "AICORE_RESOURCE_GROUP",
];

/// Which of `names` are set in the host environment, as (name, value) pairs.
/// Takes a lookup function rather than reading `std::env` directly so the
/// selection logic is unit-testable without touching real process env.
pub fn present(names: &[&str], get: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    names
        .iter()
        .filter_map(|name| get(name).map(|value| (name.to_string(), value)))
        .collect()
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
    rx.extend(detect_git_config_paths());
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
        assert!(candidates.contains(&PathBuf::from("/home/u/.local/state/opencode")));
        assert!(candidates.contains(&PathBuf::from("/home/u/.opencode")));
    }

    #[test]
    fn present_returns_only_set_vars() {
        let names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "UNSET_VAR"];
        let get = |name: &str| match name {
            "ANTHROPIC_API_KEY" => Some("sk-test".to_string()),
            _ => None,
        };
        let found = present(&names, get);
        assert_eq!(found, vec![("ANTHROPIC_API_KEY".to_string(), "sk-test".to_string())]);
    }

    #[test]
    fn present_is_empty_when_nothing_set() {
        assert!(present(&["ANTHROPIC_API_KEY"], |_| None).is_empty());
    }

    #[test]
    fn git_config_candidates_cover_gitconfig_and_xdg_git_dir() {
        let home = Path::new("/home/u");
        let config_home = Path::new("/home/u/.config");
        let candidates = git_config_candidates(home, config_home);
        assert!(candidates.contains(&PathBuf::from("/home/u/.gitconfig")));
        assert!(candidates.contains(&PathBuf::from("/home/u/.config/git")));
    }

    #[test]
    fn git_config_candidates_exclude_credentials_file() {
        let home = Path::new("/home/u");
        let config_home = Path::new("/home/u/.config");
        let candidates = git_config_candidates(home, config_home);
        assert!(!candidates.iter().any(|p| p.ends_with(".git-credentials")));
    }

    #[test]
    fn only_existing_git_config_candidates_are_allowed() {
        let dir = std::env::temp_dir().join(format!("vajra-gitcfg-test-{}", std::process::id()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".gitconfig"), "[user]\n").unwrap();
        // $XDG_CONFIG_HOME/git intentionally not created.

        let candidates = git_config_candidates(&home, &home.join(".config"));
        let existing: Vec<_> = candidates.iter().filter(|p| p.exists()).collect();
        assert_eq!(existing.len(), 1);
        assert!(existing[0].ends_with(".gitconfig"));

        std::fs::remove_dir_all(&dir).unwrap();
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
