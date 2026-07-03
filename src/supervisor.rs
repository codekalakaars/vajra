use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Separates the app's raw output from the exit-code trailer on the socket.
pub const TRAILER: u8 = 0x1E;

/// The socket lives in the user runtime dir (/run/user/<uid>), which stays
/// reachable inside the sandbox after /tmp is made private, and is short
/// enough for the unix socket path limit (SUN_LEN) — project dirs are not.
/// Without a runtime dir it falls back to /tmp, and the sandbox then keeps
/// the host /tmp shared so the socket remains reachable.
pub fn socket_path() -> PathBuf {
    let dir = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    dir.join(format!("vajra-{}.sock", std::process::id()))
}

struct RunningApp {
    pgid: i32,
}

pub struct Supervisor {
    project_dir: PathBuf,
    env_file: Option<PathBuf>,
    running: Arc<Mutex<Option<RunningApp>>>,
}

fn default_script(project_dir: &Path) -> String {
    let pkg = std::fs::read_to_string(project_dir.join("package.json")).unwrap_or_default();
    if pkg.contains("\"dev\"") {
        "dev".to_string()
    } else {
        "start".to_string()
    }
}

/// Replace every occurrence of a secret value with [REDACTED:<KEY>].
/// Values shorter than 4 chars are skipped: they are too common in ordinary
/// output to match reliably and too weak to matter.
fn redact(line: &str, secrets: &[(String, String)]) -> String {
    let mut out = line.to_string();
    for (key, value) in secrets {
        if value.len() >= 4 && out.contains(value.as_str()) {
            out = out.replace(value.as_str(), &format!("[REDACTED:{}]", key));
        }
    }
    out
}

/// Copy app output to the client line by line, scrubbing secret values.
/// Line-buffering also prevents a secret from slipping through split across
/// two read chunks.
fn pump_redacted(
    pipe: Box<dyn Read + Send>,
    sink: Arc<Mutex<UnixStream>>,
    secrets: Arc<Vec<(String, String)>>,
) {
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = redact(&String::from_utf8_lossy(&buf), &secrets);
                let mut sink = sink.lock().unwrap();
                if sink.write_all(line.as_bytes()).is_err() {
                    break;
                }
            }
        }
    }
}

fn send_trailer(stream: &mut UnixStream, code: i32) {
    let _ = stream.write_all(&[b'\n', TRAILER]);
    let _ = stream.write_all(code.to_string().as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

impl Supervisor {
    pub fn new(project_dir: PathBuf, env_file: Option<PathBuf>) -> Self {
        Supervisor {
            project_dir,
            env_file,
            running: Arc::new(Mutex::new(None)),
        }
    }

    /// Bind the run socket. Called before the sandbox forks so the path is live.
    pub fn bind(&self) -> Result<UnixListener, String> {
        let sock = socket_path();
        let _ = std::fs::remove_file(&sock);
        UnixListener::bind(&sock).map_err(|e| format!("Failed to bind {}: {}", sock.display(), e))
    }

    /// Accept-loop, meant to run on its own thread for the lifetime of the sandbox.
    pub fn serve(self: Arc<Self>, listener: UnixListener) {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let sup = Arc::clone(&self);
            std::thread::spawn(move || sup.handle(stream));
        }
    }

    /// Kill the running app (if any). Used for `--stop` and launch teardown.
    pub fn stop_app(&self) -> bool {
        let mut running = self.running.lock().unwrap();
        if let Some(app) = running.take() {
            unsafe { libc::kill(-app.pgid, libc::SIGTERM) };
            true
        } else {
            false
        }
    }

    fn handle(&self, mut stream: UnixStream) {
        let mut reader = BufReader::new(match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        });
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        let request = line.trim();

        if request == "stop" {
            let msg = if self.stop_app() { "stopped\n" } else { "no app running\n" };
            let _ = stream.write_all(msg.as_bytes());
            send_trailer(&mut stream, 0);
            return;
        }

        let script = match request.strip_prefix("run") {
            Some(rest) => {
                let rest = rest.trim();
                if rest.is_empty() {
                    default_script(&self.project_dir)
                } else {
                    rest.to_string()
                }
            }
            None => {
                let _ = stream.write_all(b"vajra: unknown request\n");
                send_trailer(&mut stream, 1);
                return;
            }
        };

        if self.running.lock().unwrap().is_some() {
            let _ = stream.write_all(b"vajra: an app is already running (use `vajra run --stop` first)\n");
            send_trailer(&mut stream, 1);
            return;
        }

        let env_vars = match &self.env_file {
            Some(path) if path.exists() => match crate::envfile::load(path) {
                Ok(vars) => vars,
                Err(e) => {
                    let _ = stream.write_all(format!("vajra: {}\n", e).as_bytes());
                    send_trailer(&mut stream, 1);
                    return;
                }
            },
            _ => Vec::new(),
        };

        let mut cmd = Command::new("npm");
        cmd.arg("run")
            .arg(&script)
            .current_dir(&self.project_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        for (key, value) in &env_vars {
            cmd.env(key, value);
        }

        let _ = stream.write_all(format!("vajra: running `npm run {}`\n", script).as_bytes());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = stream.write_all(format!("vajra: failed to start npm: {}\n", e).as_bytes());
                send_trailer(&mut stream, 1);
                return;
            }
        };

        // The app's output never reaches the sandbox directly: it is pumped
        // through the supervisor, which redacts secret values first.
        let secrets = Arc::new(env_vars);
        let sink = Arc::new(Mutex::new(match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        }));
        let pumps: Vec<_> = [
            child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
            child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .map(|pipe| {
            let sink = Arc::clone(&sink);
            let secrets = Arc::clone(&secrets);
            std::thread::spawn(move || pump_redacted(pipe, sink, secrets))
        })
        .collect();
        let pgid = child.id() as i32;
        *self.running.lock().unwrap() = Some(RunningApp { pgid });

        // If the client disconnects mid-run, kill the app's process group.
        let done = Arc::new(AtomicBool::new(false));
        {
            let done = Arc::clone(&done);
            let mut monitor = match stream.try_clone() {
                Ok(s) => s,
                Err(_) => return,
            };
            std::thread::spawn(move || {
                let mut buf = [0u8; 16];
                while let Ok(n) = monitor.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                }
                if !done.load(Ordering::SeqCst) {
                    unsafe { libc::kill(-pgid, libc::SIGTERM) };
                }
            });
        }

        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
        for pump in pumps {
            let _ = pump.join();
        }
        done.store(true, Ordering::SeqCst);
        self.running.lock().unwrap().take();
        send_trailer(&mut stream, code);
    }
}

/// Client side of the protocol: used by `vajra run` inside the sandbox.
pub fn run_client(script: Option<String>, stop: bool) -> Result<i32, String> {
    let sock = std::env::var("VAJRA_SOCK")
        .map_err(|_| "VAJRA_SOCK is not set — `vajra run` only works inside a `vajra launch` shell".to_string())?;
    let mut stream =
        UnixStream::connect(&sock).map_err(|e| format!("Failed to connect to supervisor at {}: {}", sock, e))?;

    let request = if stop {
        "stop\n".to_string()
    } else {
        match script {
            Some(s) => format!("run {}\n", s),
            None => "run\n".to_string(),
        }
    };
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let mut stdout = std::io::stdout();
    let mut buf = [0u8; 4096];
    let mut trailer = Vec::new();
    let mut in_trailer = false;
    loop {
        let n = stream.read(&mut buf).map_err(|e| format!("Read failed: {}", e))?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        if in_trailer {
            trailer.extend_from_slice(chunk);
        } else if let Some(pos) = chunk.iter().position(|&b| b == TRAILER) {
            let _ = stdout.write_all(&chunk[..pos]);
            trailer.extend_from_slice(&chunk[pos + 1..]);
            in_trailer = true;
        } else {
            let _ = stdout.write_all(chunk);
        }
        let _ = stdout.flush();
    }

    let code = String::from_utf8_lossy(&trailer).trim().parse::<i32>().unwrap_or(1);
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::redact;

    fn secrets() -> Vec<(String, String)> {
        vec![
            ("SECRET".into(), "hunter2".into()),
            ("API_KEY".into(), "sk-abc123def".into()),
            ("PORT".into(), "80".into()),
        ]
    }

    #[test]
    fn redacts_secret_values() {
        let line = "connecting with token sk-abc123def and password hunter2\n";
        assert_eq!(
            redact(line, &secrets()),
            "connecting with token [REDACTED:API_KEY] and password [REDACTED:SECRET]\n"
        );
    }

    #[test]
    fn skips_short_values() {
        // "80" is too short to redact; matching it would mangle ordinary output.
        assert_eq!(redact("listening on port 80\n", &secrets()), "listening on port 80\n");
    }

    #[test]
    fn redacts_repeated_occurrences() {
        assert_eq!(
            redact("hunter2 hunter2", &secrets()),
            "[REDACTED:SECRET] [REDACTED:SECRET]"
        );
    }

    #[test]
    fn leaves_clean_lines_untouched(){
        let line = "server started on :3000\n";
        assert_eq!(redact(line, &secrets()), line);
    }
}
