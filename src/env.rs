use napi::Error;
use std::env;

#[napi]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[napi]
pub fn get_env(key: String) -> Option<String> {
    env::var(&key).ok()
}

#[napi]
pub fn set_env(key: String, value: String) -> Result<(), Error> {
    env::set_var(&key, &value);
    Ok(())
}

#[napi]
pub fn remove_env(key: String) -> Result<(), Error> {
    env::remove_var(&key);
    Ok(())
}

#[napi]
pub fn env_exists(key: String) -> bool {
    env::var(&key).is_ok()
}

#[napi]
pub fn get_all_env() -> Vec<EnvVar> {
    env::vars()
        .map(|(key, value)| EnvVar { key, value })
        .collect()
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

#[napi]
pub fn set_current_dir(path: String) -> Result<(), Error> {
    env::set_current_dir(&path)
        .map_err(|e| Error::from_reason(format!("Failed to set current directory to '{}': {}", path, e)))
}

#[napi]
pub fn home_dir() -> Option<String> {
    dirs_fn().map(|s| s.to_string())
}

#[napi]
pub fn temp_dir() -> String {
    env::temp_dir().to_string_lossy().to_string()
}

fn dirs_fn() -> Option<String> {
    if cfg!(target_os = "windows") {
        env::var("USERPROFILE").ok()
    } else {
        env::var("HOME").ok()
    }
}
