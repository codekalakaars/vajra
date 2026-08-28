use napi::Error;
use std::process::Command;

#[napi]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

#[napi]
pub fn run_command(command: String, args: Option<Vec<String>>, cwd: Option<String>) -> Result<CommandResult, Error> {
    let mut cmd = Command::new(&command);
    
    if let Some(args) = args {
        cmd.args(&args);
    }
    
    if let Some(cwd) = cwd {
        cmd.current_dir(&cwd);
    }
    
    let output = cmd.output()
        .map_err(|e| Error::from_reason(format!("Failed to execute '{}': {}", command, e)))?;
    
    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}

#[napi]
pub fn run_shell(command: String, cwd: Option<String>) -> Result<CommandResult, Error> {
    let mut cmd = Command::new(if cfg!(target_os = "windows") { "cmd" } else { "sh" });
    
    if cfg!(target_os = "windows") {
        cmd.arg("/C");
    } else {
        cmd.arg("-c");
    }
    
    cmd.arg(&command);
    
    if let Some(cwd) = cwd {
        cmd.current_dir(&cwd);
    }
    
    let output = cmd.output()
        .map_err(|e| Error::from_reason(format!("Failed to execute shell command: {}", e)))?;
    
    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}

#[napi]
pub fn which(command: String) -> Result<Option<String>, Error> {
    let mut cmd = Command::new(if cfg!(target_os = "windows") { "where" } else { "which" });
    cmd.arg(&command);
    
    let output = cmd.output();
    
    match output {
        Ok(output) => {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                Ok(Some(path))
            } else {
                Ok(None)
            }
        }
        Err(_) => Ok(None),
    }
}
