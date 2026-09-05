//! Per-project persisted launch choices: .vajra.toml in the project dir.
//! Created after the first interactive env-file selection so later launches
//! skip the picker. Contains only file names and paths, never secret values.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = ".vajra.toml";

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Config {
    /// Env file (relative to the project dir) the supervisor loads for runs.
    pub env: Option<String>,
    /// Sample env file left visible to the agent.
    pub sample: Option<String>,
    /// Extra read+execute dirs, same meaning as repeated --allow flags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// Extra read+write dirs, same meaning as repeated --allow-rw flags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow_rw: Vec<String>,
    /// Per-file permissions for the Landlock sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<crate::permissions::PermissionsConfig>,
}

fn path_in(project_dir: &Path) -> PathBuf {
    project_dir.join(FILE_NAME)
}

/// Load the project config if one exists. A malformed file is an error, not
/// a silent fallback to the picker, so typos don't quietly change behavior.
pub fn load(project_dir: &Path) -> Result<Option<Config>, String> {
    let path = path_in(project_dir);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    toml::from_str(&content)
        .map(Some)
        .map_err(|e| format!("Invalid {}: {}", path.display(), e))
}

pub fn save(project_dir: &Path, config: &Config) -> Result<(), String> {
    let path = path_in(project_dir);
    let body = toml::to_string_pretty(config).map_err(|e| format!("Serialize failed: {}", e))?;
    let content = format!(
        "# vajra launch settings for this project (no secrets stored here).\n# Delete this file or run `vajra launch --reconfigure` to choose again.\n{}",
        body
    );
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("vajra-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            env: Some(".env".into()),
            sample: Some(".sample.env".into()),
            allow: vec!["/opt/tools".into()],
            allow_rw: vec!["/opt/state".into()],
            permissions: None,
        };
        save(&dir, &config).unwrap();
        assert_eq!(load(&dir).unwrap(), Some(config));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_file_is_none() {
        let dir = std::env::temp_dir().join(format!("vajra-cfg-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load(&dir).unwrap(), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn malformed_file_is_error() {
        let dir = std::env::temp_dir().join(format!("vajra-cfg-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), "env = [not toml").unwrap();
        assert!(load(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn allow_defaults_to_empty() {
        let config: Config = toml::from_str("env = \".env\"").unwrap();
        assert_eq!(config.env.as_deref(), Some(".env"));
        assert!(config.allow.is_empty());
        assert!(config.allow_rw.is_empty());
    }
}
