use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Task};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[napi(object)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    /// Exit code, or -1 when the process was terminated by a signal.
    pub code: i32,
}

fn finish(command: &str, output: std::io::Result<std::process::Output>) -> Result<CommandResult, Error> {
    let output = output
        .map_err(|e| Error::from_reason(format!("Failed to execute '{}': {}", command, e)))?;

    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}

fn read_stream<R: Read + Send + 'static>(mut stream: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stream.read_to_end(&mut output);
        output
    })
}

fn collect_stream(handle: thread::JoinHandle<Vec<u8>>, timeout: Duration) -> Vec<u8> {
    let deadline = Instant::now() + timeout;
    while !handle.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    if handle.is_finished() {
        handle.join().unwrap_or_default()
    } else {
        Vec::new()
    }
}

#[cfg(unix)]
fn terminate_process(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.kill();
}

#[cfg(not(unix))]
fn terminate_process(child: &mut Child) {
    let _ = child.kill();
}

fn run_command_with_timeout(
    command: &str,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    timeout_ms: u64,
) -> Result<CommandResult, Error> {
    let mut cmd = Command::new(command);
    if let Some(args) = args {
        cmd.args(&args);
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(&cwd);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            let _ = libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| Error::from_reason(format!("Failed to execute '{}': {}", command, e)))?;
    let stdout = read_stream(child.stdout.take().expect("stdout pipe"));
    let stderr = read_stream(child.stderr.take().expect("stderr pipe"));
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                terminate_process(&mut child);
                let _ = child.wait();
                let _ = collect_stream(stdout, Duration::from_millis(250));
                let _ = collect_stream(stderr, Duration::from_millis(250));
                return Ok(CommandResult {
                    stdout: String::new(),
                    stderr: "Command timed out".to_string(),
                    code: 124,
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(Error::from_reason(format!("Failed to wait for '{}': {}", command, e))),
        }
    };

    let stdout = collect_stream(stdout, Duration::from_secs(5));
    let stderr = collect_stream(stderr, Duration::from_secs(5));
    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        code: status.code().unwrap_or(-1),
    })
}

/// Run a program directly, without a shell.
#[napi]
pub fn run_command(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<CommandResult, Error> {
    let mut cmd = Command::new(&command);

    if let Some(args) = args {
        cmd.args(&args);
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(&cwd);
    }

    finish(&command, cmd.output())
}

/// Run a command through the platform shell. Prefer `runCommand` for
/// untrusted input — shell interpolation executes as code.
#[napi]
pub fn run_shell(command: String, cwd: Option<String>) -> Result<CommandResult, Error> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/C");
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c");
        c
    };

    cmd.arg(&command);

    if let Some(cwd) = cwd {
        cmd.current_dir(&cwd);
    }

    finish(&command, cmd.output())
}

/// Async counterparts that run on the libuv threadpool.
pub struct RunTask {
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    shell: bool,
    timeout_ms: Option<u64>,
}

impl Task for RunTask {
    type Output = CommandResult;
    type JsValue = CommandResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        if self.shell {
            run_shell(self.command.clone(), self.cwd.clone())
        } else if let Some(timeout_ms) = self.timeout_ms {
            run_command_with_timeout(
                &self.command,
                self.args.clone(),
                self.cwd.clone(),
                timeout_ms,
            )
        } else {
            run_command(self.command.clone(), self.args.clone(), self.cwd.clone())
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<CommandResult>")]
pub fn run_command_async(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> AsyncTask<RunTask> {
    AsyncTask::new(RunTask {
        command,
        args,
        cwd,
        shell: false,
        timeout_ms: None,
    })
}

#[napi(ts_return_type = "Promise<CommandResult>")]
pub fn run_command_async_timeout(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    timeout_ms: u32,
) -> AsyncTask<RunTask> {
    AsyncTask::new(RunTask {
        command,
        args,
        cwd,
        shell: false,
        timeout_ms: Some(timeout_ms as u64),
    })
}

#[napi(ts_return_type = "Promise<CommandResult>")]
pub fn run_shell_async(command: String, cwd: Option<String>) -> AsyncTask<RunTask> {
    AsyncTask::new(RunTask {
        command,
        args: None,
        cwd,
        shell: true,
        timeout_ms: None,
    })
}

/// Candidate filenames for `command` on this platform.
#[cfg(windows)]
fn candidate_names(command: &str) -> Vec<String> {
    if Path::new(command).extension().is_some() {
        return vec![command.to_string()];
    }

    let pathext = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());

    pathext
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| format!("{}{}", command, ext))
        .collect()
}

#[cfg(not(windows))]
fn candidate_names(command: &str) -> Vec<String> {
    vec![command.to_string()]
}

/// True if `path` is a file we could actually execute.
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Locate an executable on PATH, returning its full path.
#[napi]
pub fn which(command: String) -> Option<String> {
    if command.is_empty() {
        return None;
    }

    // A path with a separator is a location, not a name to look up.
    if command.contains('/') || (cfg!(windows) && command.contains('\\')) {
        let path = PathBuf::from(&command);
        return is_executable(&path).then(|| path.to_string_lossy().to_string());
    }

    let path_var = std::env::var_os("PATH")?;

    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in candidate_names(&command) {
            let candidate = dir.join(&name);
            if is_executable(&candidate) {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_a_command_and_captures_stdout() {
        let result = if cfg!(windows) {
            run_command("cmd".into(), Some(vec!["/C".into(), "echo hi".into()]), None)
        } else {
            run_command("echo".into(), Some(vec!["hi".into()]), None)
        }
        .unwrap();

        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("hi"));
    }

    #[test]
    fn reports_nonzero_exit_codes() {
        let result = run_shell("exit 3".into(), None).unwrap();
        assert_eq!(result.code, 3);
    }

    #[test]
    fn missing_program_is_an_error_not_a_result() {
        assert!(run_command("vajra-no-such-program".into(), None, None).is_err());
    }

    #[test]
    fn which_finds_a_known_executable() {
        let known = if cfg!(windows) { "cmd" } else { "sh" };
        let found = which(known.into()).expect("expected to find the shell on PATH");
        assert!(Path::new(&found).is_absolute());
        assert!(is_executable(Path::new(&found)));
    }

    #[test]
    fn which_returns_a_single_path() {
        // `where` on Windows prints one line per match; the result must never be
        // a multi-line blob.
        let known = if cfg!(windows) { "cmd" } else { "sh" };
        let found = which(known.into()).unwrap();
        assert!(!found.contains('\n'));
    }

    #[test]
    fn which_misses_are_none() {
        assert!(which("vajra-no-such-program".into()).is_none());
        assert!(which("".into()).is_none());
    }
}
