use std::ffi::CString;

use nix::mount::{mount, umount, MsFlags};
use nix::sched::{unshare, CloneFlags};
use nix::sys::wait::waitpid;
use nix::unistd::{execvp, fork, ForkResult};

pub struct SandboxConfig {
    pub project_dir: String,
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

pub fn launch_sandbox(config: SandboxConfig) -> Result<(), String> {
    unshare(CloneFlags::CLONE_NEWPID | CloneFlags::CLONE_NEWNS)
        .map_err(|e| format!("unshare failed: {}", e))?;

    mount_new_proc()?;

    crate::landlock::restrict_filesystem(&config.project_dir)?;

    match unsafe { fork() }.map_err(|e| format!("fork failed: {}", e))? {
        ForkResult::Child => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let shell_c = CString::new(shell).map_err(|_| "Invalid shell path".to_string())?;
            let arg_i = CString::new("-i").map_err(|_| "Invalid arg".to_string())?;
            let args = [arg_i.as_c_str()];

            return match execvp(&shell_c, &args) {
                Ok(_) => unreachable!(),
                Err(e) => Err(format!("execvp failed: {}", e)),
            };
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
