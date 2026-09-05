use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;

use crate::permissions;

const HTML: &str = include_str!("gui/index.html");

pub fn start(project_dir: &Path, host: &str, port: u16) -> Result<(), String> {
    let addr = format!("{}:{}", host, port);
    let listener =
        TcpListener::bind(&addr).map_err(|e| format!("bind {}: {}", addr, e))?;

    eprintln!("vajra permissions GUI at http://{}", addr);

    let url = format!("http://{}", addr);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        open_browser(&url);
    });

    let project_dir = Arc::new(project_dir.to_path_buf());

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let dir = Arc::clone(&project_dir);
                if let Err(e) = handle_client(stream, &dir) {
                    eprintln!("request error: {}", e);
                }
            }
            Err(e) => {
                eprintln!("accept error: {}", e);
            }
        }
    }

    Ok(())
}

fn handle_client(mut stream: TcpStream, project_dir: &Path) -> Result<(), String> {
    let mut reader = BufReader::new(&stream);

    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| format!("read request line: {}", e))?;

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        let _ = respond(&mut stream, 400, "text/plain", b"Bad Request");
        return Ok(());
    }

    let method = parts[0];
    let path = parts[1];
    let mut content_length: usize = 0;

    loop {
        let mut header = String::new();
        reader
            .read_line(&mut header)
            .map_err(|e| format!("read header: {}", e))?;
        if header.trim().is_empty() {
            break;
        }
        if let Some(val) = header
            .strip_prefix("Content-Length:")
            .or_else(|| header.strip_prefix("content-length:"))
        {
            content_length = val.trim().parse().unwrap_or(0);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|e| format!("read body: {}", e))?;
    }

    match (method, path) {
        ("GET", "/") => {
            let _ = respond(
                &mut stream,
                200,
                "text/html; charset=utf-8",
                HTML.as_bytes(),
            );
        }
        ("GET", "/api/tree") => match permissions::scan_tree(project_dir) {
            Ok(tree) => {
                let json = serde_json::to_string(&tree).unwrap_or_else(|_| "null".to_string());
                let _ = respond(&mut stream, 200, "application/json", json.as_bytes());
            }
            Err(e) => {
                let err = format!(r#"{{"error":"{}"}}"#, e);
                let _ = respond(&mut stream, 500, "application/json", err.as_bytes());
            }
        },
        ("GET", "/api/permissions") => {
            let cfg = crate::config::load(project_dir)
                .unwrap_or(None)
                .unwrap_or_default();
            let config = cfg.permissions.unwrap_or_else(permissions::default_config);
            let json = serde_json::to_string(&config).unwrap_or_else(|_| "null".to_string());
            let _ = respond(&mut stream, 200, "application/json", json.as_bytes());
        }
        ("PUT", "/api/permissions") => {
            match serde_json::from_slice::<permissions::PermissionsConfig>(&body) {
                Ok(perms) => {
                    let mut cfg = crate::config::load(project_dir)
                        .unwrap_or(None)
                        .unwrap_or_default();
                    cfg.permissions = Some(perms);
                    match crate::config::save(project_dir, &cfg) {
                        Ok(_) => {
                            let _ = respond(&mut stream, 200, "application/json", b"{\"ok\":true}");
                        }
                        Err(e) => {
                            let err = format!(r#"{{"error":"{}"}}"#, e);
                            let _ = respond(&mut stream, 500, "application/json", err.as_bytes());
                        }
                    }
                }
                Err(e) => {
                    let err = format!(r#"{{"error":"invalid JSON: {}"}}"#, e);
                    let _ = respond(&mut stream, 400, "application/json", err.as_bytes());
                }
            }
        }
        ("GET", "/api/system-paths") => {
            let rx = crate::allow::detect_toolchain_dirs();
            let rw = crate::allow::detect_agent_state_dirs();
            let git = crate::allow::detect_git_config_paths();
            let obj = serde_json::json!({
                "toolchain_rx": rx,
                "agent_state_rw": rw,
                "git_config": git,
            });
            let json = obj.to_string();
            let _ = respond(&mut stream, 200, "application/json", json.as_bytes());
        }
        _ => {
            let _ = respond(&mut stream, 404, "text/plain", b"Not Found");
        }
    }

    Ok(())
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "",
    };

    let headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        status,
        status_text,
        content_type,
        body.len()
    );

    let mut response = headers.into_bytes();
    response.extend_from_slice(body);
    stream
        .write_all(&response)
        .map_err(|e| format!("write response: {}", e))
}

fn open_browser(url: &str) {
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", url])
        .spawn();
}
