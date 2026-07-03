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
    /// Extra read+write dirs (agent state, --allow-rw flags).
    pub allowed_rw_paths: Vec<String>,
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

/// Give the sandbox its own empty /tmp so it cannot read other processes'
/// temp files or tamper with other sockets. Skipped (shared /tmp kept) when
/// the supervisor socket itself lives in /tmp, i.e. no XDG_RUNTIME_DIR.
fn mount_private_tmp(sock_path: &Option<String>) -> Result<(), String> {
    if let Some(sock) = sock_path
        && sock.starts_with("/tmp/") {
            eprintln!("vajra: no user runtime dir; keeping host /tmp shared in the sandbox");
            return Ok(());
        }
    mount::<str, str, str, str>(
        Some("tmpfs"),
        "/tmp",
        Some("tmpfs"),
        MsFlags::MS_NOSUID | MsFlags::MS_NODEV,
        Some("mode=1777"),
    )
    .map_err(|e| format!("mount private /tmp failed: {}", e))
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
/// TERM_PROGRAM/TERM_PROGRAM_VERSION are display metadata (which terminal
/// emulator is hosting the shell) rather than secrets, and terminals like
/// Warp use them to detect their own subshells and re-enable integrations
/// (autosuggestions, blocks) once the shell sources the rc file we provide.
fn build_clean_env(sock_path: &Option<String>) -> Vec<CString> {
    let mut env = Vec::new();
    for key in [
        "PATH",
        "HOME",
        "TERM",
        "SHELL",
        "LANG",
        "USER",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
    ] {
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

    // Export the XDG base dirs explicitly (host value if set, else the
    // standard $HOME-relative default) so tools resolving them can't drift
    // from what we allowlisted via allow::detect_agent_state_dirs.
    if let Ok(home) = std::env::var("HOME") {
        for (var, default_suffix) in [
            ("XDG_DATA_HOME", ".local/share"),
            ("XDG_CONFIG_HOME", ".config"),
            ("XDG_CACHE_HOME", ".cache"),
            ("XDG_STATE_HOME", ".local/state"),
        ] {
            let value = std::env::var(var)
                .unwrap_or_else(|_| format!("{}/{}", home.trim_end_matches('/'), default_suffix));
            env.push(CString::new(format!("{}={}", var, value)).unwrap());
        }
    }

    // The agent's own LLM/tool credentials, distinct from the project's
    // .env secrets: these belong to the developer's host environment and
    // must pass through for the agent to function at all.
    for (key, value) in crate::allow::present(crate::allow::AGENT_ENV_PASSTHROUGH, |name| {
        std::env::var(name).ok()
    }) {
        if let Ok(entry) = CString::new(format!("{}={}", key, value)) {
            env.push(entry);
        }
    }

    env
}

/// Bash rc content for the sandboxed shell: a distinct prompt so it's
/// obvious the shell is sandboxed, plus Warp's documented "warpify" hook so
/// Warp's subshell integration (autosuggestions, command blocks) re-attaches
/// to this shell. Harmless no-op in any other terminal since it's gated on
/// TERM_PROGRAM.
const SANDBOX_RC: &str = r#"PS1='[vajra] \w \$ '
if [ "$TERM_PROGRAM" = "WarpTerminal" ]; then
    printf '\eP$f{"hook": "SourcedRcFileForWarp", "value": { "shell": "bash" }}\x9c'
fi
"#;

/// Write the sandbox rc file into the (already private) /tmp and return the
/// bash args to use it, falling back to --norc if it can't be written.
fn shell_rc_args(shell_name: &str) -> Vec<CString> {
    let rc_path = format!("/tmp/.vajra-rc-{}", std::process::id());
    let use_rc = std::fs::write(&rc_path, SANDBOX_RC).is_ok();

    let mut args = vec![
        CString::new(shell_name).unwrap(),
        CString::new("--noprofile").unwrap(),
    ];
    if use_rc {
        args.push(CString::new("--rcfile").unwrap());
        args.push(CString::new(rc_path).unwrap());
    } else {
        args.push(CString::new("--norc").unwrap());
    }
    args.push(CString::new("-i").unwrap());
    args
}

pub fn launch_sandbox(config: SandboxConfig) -> Result<(), String> {
    unshare(CloneFlags::CLONE_NEWPID | CloneFlags::CLONE_NEWNS)
        .map_err(|e| format!("unshare failed: {}. Try: sudo setcap cap_sys_admin+ep target/debug/vajra", e))?;

    mount_new_proc()?;

    mount_private_tmp(&config.sock_path)?;

    mask_env_files(&config.masked_files)?;

    crate::landlock::restrict_filesystem(
        &config.project_dir,
        &config.allowed_paths,
        &config.allowed_rw_paths,
    )?;

    match unsafe { fork() }.map_err(|e| format!("fork failed: {}", e))? {
        ForkResult::Child => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let shell_c = CString::new(shell.clone()).map_err(|_| "Invalid shell path".to_string())?;
            let shell_name = std::path::Path::new(&shell)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("bash");
            let args = shell_rc_args(shell_name);
            let arg_refs: Vec<&std::ffi::CStr> = args.iter().map(|a| a.as_c_str()).collect();
            let env = build_clean_env(&config.sock_path);
            let env_refs: Vec<&std::ffi::CStr> = env.iter().map(|e| e.as_c_str()).collect();

            match execve(&shell_c, &arg_refs, &env_refs) {
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
