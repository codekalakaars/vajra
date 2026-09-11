use napi::Error;
use std::env;

#[napi(object)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

// Note: there are deliberately no setEnv/removeEnv bindings here.
//
// `std::env::set_var` and `remove_var` mutate process-global state that other
// threads may be reading concurrently, which is undefined behaviour — Rust 2024
// makes both `unsafe` for exactly this reason, and Node runs worker threads.
// JavaScript callers should assign to `process.env` instead, and pass any
// per-process overrides explicitly via `runCommand`.

#[napi]
pub fn get_env(key: String) -> Option<String> {
    env::var(&key).ok()
}

#[napi]
pub fn env_exists(key: String) -> bool {
    env::var_os(&key).is_some()
}

#[napi]
pub fn get_all_env() -> Vec<EnvVar> {
    env::vars().map(|(key, value)| EnvVar { key, value }).collect()
}

#[napi]
pub fn get_env_filtered(prefix: String) -> Vec<EnvVar> {
    env::vars()
        .filter(|(key, _)| key.starts_with(&prefix))
        .map(|(key, value)| EnvVar { key, value })
        .collect()
}

#[napi]
pub fn current_dir() -> Result<String, Error> {
    env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| Error::from_reason(format!("Failed to get current directory: {}", e)))
}

/// Change the process working directory.
///
/// This is process-global and affects every thread, including Node's. Prefer
/// passing `cwd` to `runCommand`/`runShell` over changing it here.
#[napi]
pub fn set_current_dir(path: String) -> Result<(), Error> {
    env::set_current_dir(&path).map_err(|e| {
        Error::from_reason(format!("Failed to set current directory to '{}': {}", path, e))
    })
}

#[napi]
pub fn home_dir() -> Option<String> {
    // Resolved from the environment rather than a crate: the sandbox may have
    // been given a different HOME on purpose, and that is the one to honour.
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

    env::var_os(key)
        .map(|v| v.to_string_lossy().to_string())
        .filter(|v| !v.is_empty())
}

#[napi]
pub fn temp_dir() -> String {
    env::temp_dir().to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_existing_var() {
        // PATH is present on all three target platforms.
        assert!(env_exists("PATH".into()));
        assert!(get_env("PATH".into()).is_some());
    }

    #[test]
    fn missing_vars_are_none() {
        assert!(!env_exists("VAJRA_DEFINITELY_NOT_SET".into()));
        assert!(get_env("VAJRA_DEFINITELY_NOT_SET".into()).is_none());
    }

    #[test]
    fn filter_matches_prefix_only() {
        let all = get_all_env();
        assert!(!all.is_empty());

        let filtered = get_env_filtered("PATH".into());
        assert!(filtered.iter().all(|v| v.key.starts_with("PATH")));
        assert!(filtered.len() <= all.len());
    }

    #[test]
    fn temp_and_current_dir_are_usable_paths() {
        assert!(!temp_dir().is_empty());
        assert!(std::path::Path::new(&current_dir().unwrap()).is_absolute());
    }
}
