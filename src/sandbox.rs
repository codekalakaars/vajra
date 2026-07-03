use std::ffi::CString;
use std::path::PathBuf;

use nix::mount::{mount, umount, MsFlags};
use nix::sched::{unshare, CloneFlags};
use nix::sys::wait::waitpid;
use nix::unistd::{execve, fork, ForkResult};

pub struct SandboxConfig {
    pub project_dir: String,
    /// Env-like files to hide inside the sandbox (bind-mounted over with an empty RO file).
    pub masked_files: Vec<PathBuf>,
    /// Path to the supervisor's run socket, exported as VAJRA_SOCK.
    pub sock_path: Option<String>,
    /// Extra read+execute dirs (toolchains, --allow flags).
    pub allowed_paths: Vec<String>,
}

fn mount_new_proc() -> Result<(), String> {
    mount::<str, str, str, str>(
        None::<&str>,
        "/",
        None::<&str>,
        MsFlags::MS_REC | MsFlags::MS_PRIVATE,
        None::<&str>,
    )
    .map_err(|e| format!("mount private failed: {}", e))?;

    let _ = umount("/proc");

    mount::<str, str, str, str>(
        Some("proc"),
        "/proc",
        Some("proc"),
        MsFlags::MS_NOSUID | MsFlags::MS_NODEV | MsFlags::MS_NOEXEC,
        None::<&str>,
    )
    .map_err(|e| format!("mount /proc failed: {}", e))?;

    Ok(())
}

/// Hide each masked file by bind-mounting an empty read-only file over it.
/// Must run inside the private mount namespace, before Landlock is applied.
fn mask_env_files(masked: &[PathBuf]) -> Result<(), String> {
    if masked.is_empty() {
        return Ok(());
    }
    let empty = format!("/tmp/.vajra-empty-{}", std::process::id());
    std::fs::write(&empty, b"").map_err(|e| format!("Failed to create mask file: {}", e))?;

    for target in masked {
        if !target.exists() {
            continue;
        }
        mount::<str, PathBuf, str, str>(
            Some(empty.as_str()),
            target,
            None::<&str>,
            MsFlags::MS_BIND,
            None::<&str>,
        )
        .map_err(|e| format!("mask bind mount for {} failed: {}", target.display(), e))?;

        mount::<str, PathBuf, str, str>(
            None::<&str>,
            target,
            None::<&str>,
            MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
            None::<&str>,
        )
        .map_err(|e| format!("mask RO remount for {} failed: {}", target.display(), e))?;
    }
    Ok(())
}

/// Minimal environment for the sandboxed shell: host env vars are stripped,
/// only these pass through (plus VAJRA_SOCK for the run client).
fn build_clean_env(sock_path: &Option<String>) -> Vec<CString> {
    let mut env = Vec::new();
    for key in ["PATH", "HOME", "TERM", "SHELL", "LANG", "USER"] {
        if let Ok(mut val) = std::env::var(key) {
            if key == "PATH" {
                // Make the sibling vajra-run client resolvable inside the sandbox.
                if let Ok(exe) = std::fs::read_link("/proc/self/exe")
                    && let Some(dir) = exe.parent().and_then(|d| d.to_str()) {
                        val = format!("{}:{}", dir, val);
                    }
            }
            env.push(CString::new(format!("{}={}", key, val)).unwrap());
        }
    }
    if let Some(sock) = sock_path {
        env.push(CString::new(format!("VAJRA_SOCK={}", sock)).unwrap());
    }
    env
}

pub fn launch_sandbox(config: SandboxConfig) -> Result<(), String> {
    unshare(CloneFlags::CLONE_NEWPID | CloneFlags::CLONE_NEWNS)
        .map_err(|e| format!("unshare failed: {}. Try: sudo setcap cap_sys_admin+ep target/debug/vajra", e))?;

    mount_new_proc()?;

    mask_env_files(&config.masked_files)?;

    crate::landlock::restrict_filesystem(&config.project_dir, &config.allowed_paths)?;

    match unsafe { fork() }.map_err(|e| format!("fork failed: {}", e))? {
        ForkResult::Child => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let shell_c = CString::new(shell.clone()).map_err(|_| "Invalid shell path".to_string())?;
            let shell_name = std::path::Path::new(&shell)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("bash");
            let shell_name_c = CString::new(shell_name).map_err(|_| "Invalid arg".to_string())?;
            let arg_noprofile = CString::new("--noprofile").map_err(|_| "Invalid arg".to_string())?;
            let arg_norc = CString::new("--norc").map_err(|_| "Invalid arg".to_string())?;
            let arg_i = CString::new("-i").map_err(|_| "Invalid arg".to_string())?;
            let args = [
                shell_name_c.as_c_str(),
                arg_noprofile.as_c_str(),
                arg_norc.as_c_str(),
                arg_i.as_c_str(),
            ];
            let env = build_clean_env(&config.sock_path);
            let env_refs: Vec<&std::ffi::CStr> = env.iter().map(|e| e.as_c_str()).collect();

            match execve(&shell_c, &args, &env_refs) {
                Ok(_) => unreachable!(),
                Err(e) => Err(format!("execve failed: {}", e)),
            }
        }
        ForkResult::Parent { child } => match waitpid(child, None)
            .map_err(|e| format!("waitpid failed: {}", e))?
        {
            nix::sys::wait::WaitStatus::Exited(_, 0) => Ok(()),
            nix::sys::wait::WaitStatus::Exited(_, code) => {
                Err(format!("Sandbox exited with code {}", code))
            }
            nix::sys::wait::WaitStatus::Signaled(_, sig, _) => {
                Err(format!("Sandbox killed by signal {:?}", sig))
            }
            _ => Ok(()),
        },
    }
}
