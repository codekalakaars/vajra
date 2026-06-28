use std::collections::HashMap;

pub struct SandboxConfig {
    pub project_dir: String,
    pub env_vars: HashMap<String, String>,
}

pub fn launch_sandbox(_config: SandboxConfig) -> Result<(), String> {
    // 1. clearenv — wipe host env
    // 2. inject env_vars
    // 3. setup landlock rules
    // 4. unshare namespaces
    // 5. fork + mount new /proc
    // 6. exec shell
    Err("Not yet implemented".to_string())
}
