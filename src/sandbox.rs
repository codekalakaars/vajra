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

fn setup_user_ns() -> Result<(), String> {
    unshare(CloneFlags::CLONE_NEWUSER)
        .map_err(|e| format!("user namespace failed: {}", e))?;

    let pid = std::process::id();
    let uid = nix::unistd::Uid::current().as_raw();
    let gid = nix::unistd::Gid::current().as_raw();

    let map_err = || "Install uidmap package: sudo apt install uidmap".to_string();

    std::process::Command::new("newuidmap")
        .arg(pid.to_string())
        .arg("0")
        .arg(uid.to_string())
        .arg("1")
        .status()
        .map_err(|_| map_err())?
        .success()
        .then_some(())
        .ok_or_else(map_err)?;

    let _ = std::process::Command::new("newgidmap")
        .arg(pid.to_string())
        .arg("0")
        .arg(gid.to_string())
        .arg("1")
        .status();

    Ok(())
}

pub fn launch_sandbox(config: SandboxConfig) -> Result<(), String> {
    setup_user_ns()?;

    unshare(CloneFlags::CLONE_NEWPID | CloneFlags::CLONE_NEWNS)
        .map_err(|e| format!("ns unshare failed: {}", e))?;

    mount_new_proc()?;

    crate::landlock::restrict_filesystem(&config.project_dir)?;

    match unsafe { fork() }.map_err(|e| format!("fork failed: {}", e))? {
        ForkResult::Child => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let shell_c = CString::new(shell).map_err(|_| "Invalid shell path".to_string())?;
            let arg_norc = CString::new("--norc").map_err(|_| "Invalid arg".to_string())?;
            let arg_i = CString::new("-i").map_err(|_| "Invalid arg".to_string())?;
            let args = [arg_norc.as_c_str(), arg_i.as_c_str()];

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
