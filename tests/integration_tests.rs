use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

fn temp_project(files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "vajra-int-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    for (name, content) in files {
        fs::write(dir.join(name), content).unwrap();
    }
    dir
}

fn vajra_binary() -> PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop(); // remove test binary name
    path.pop(); // remove deps/
    path.push("vajra");
    path
}

#[test]
fn supervisor_handles_stop_request() {
    let project_dir = temp_project(&[]);
    let sup = Arc::new(vajra::supervisor::Supervisor::new(
        project_dir.clone(),
        None,
    ));
    let listener = sup.bind().expect("bind should succeed");
    let sock = vajra::supervisor::socket_path();

    std::thread::spawn(move || sup.serve(listener));
    std::thread::sleep(Duration::from_millis(50));

    unsafe { std::env::set_var("VAJRA_SOCK", &sock) };
    let code = vajra::supervisor::run_client(None, true).expect("run_client should succeed");
    assert_eq!(code, 0, "stop request should return 0");

    let _ = fs::remove_file(&sock);
    let _ = fs::remove_dir_all(&project_dir);
}

#[test]
fn cli_version_outputs_version() {
    let output = Command::new(vajra_binary())
        .arg("--version")
        .output()
        .expect("failed to run vajra");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("vajra"));
    assert!(stdout.contains("0.1.0"));
}

#[test]
fn cli_status_outside_sandbox_returns_error() {
    let output = Command::new(vajra_binary())
        .arg("status")
        .env_remove("VAJRA_SOCK")
        .output()
        .expect("failed to run vajra");

    assert!(!output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("not running inside sandbox"));
}

#[test]
fn cli_validate_missing_config_fails() {
    let project_dir = temp_project(&[]);
    let output = Command::new(vajra_binary())
        .arg("validate")
        .current_dir(&project_dir)
        .output()
        .expect("failed to run vajra");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("no .vajra.toml found"));

    let _ = fs::remove_dir_all(&project_dir);
}

#[test]
fn cli_validate_valid_config_passes() {
    let project_dir = temp_project(&[
        (".vajra.toml", "env = \".env\"\nsample = \".sample.env\"\n"),
        (".env", "SECRET=test\n"),
        (".sample.env", "SECRET=\n"),
    ]);

    let output = Command::new(vajra_binary())
        .arg("validate")
        .current_dir(&project_dir)
        .output()
        .expect("failed to run vajra");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("is valid"));

    let _ = fs::remove_dir_all(&project_dir);
}

#[test]
fn cli_dry_run_shows_summary() {
    let project_dir = temp_project(&[
        (".vajra.toml", "env = \".env\"\nsample = \".sample.env\"\n"),
        (".env", "SECRET=test\n"),
        (".sample.env", "SECRET=\n"),
    ]);

    let output = Command::new(vajra_binary())
        .args(["launch", "--dry-run"])
        .current_dir(&project_dir)
        .output()
        .expect("failed to run vajra");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("DRY RUN SUMMARY"));
    assert!(stdout.contains("Project directory"));
    assert!(stdout.contains("Original env file"));
    assert!(stdout.contains("Sample env file"));
    assert!(stdout.contains("No sandbox was launched"));

    let _ = fs::remove_dir_all(&project_dir);
}

#[test]
#[ignore = "requires CAP_SYS_ADMIN on the vajra binary"]
fn sandbox_masks_env_file() {
    let project_dir = temp_project(&[(".env", "SECRET=hunter2\n"), (".sample.env", "SECRET=\n")]);

    let test_shell = project_dir.join("test-shell.sh");
    fs::write(&test_shell, "#!/bin/bash\ncat .env\nexit 0\n").unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&test_shell, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let output = Command::new(vajra_binary())
        .args(["launch", "--env", ".env", "--sample", ".sample.env"])
        .env("SHELL", &test_shell)
        .current_dir(&project_dir)
        .output()
        .expect("failed to run vajra");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("[vajra sandbox]"),
        "expected masked warning in output, got: {}",
        stdout
    );
    assert!(
        stdout.contains("hidden for security"),
        "expected masked warning in output, got: {}",
        stdout
    );

    let _ = fs::remove_dir_all(&project_dir);
}
