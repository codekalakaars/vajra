use std::io::Write;
use std::path::{Path, PathBuf};

/// The outcome of env-file selection for a launch.
pub struct EnvSelection {
    /// The secrets source the supervisor loads for `vajra run`.
    pub original: Option<PathBuf>,
    /// The visible reference file inside the sandbox.
    pub sample: Option<PathBuf>,
    /// Every detected env-like file to mask inside the sandbox (sample excluded).
    pub masked: Vec<PathBuf>,
}

/// A file counts as env-like if it is `.env`, `.env.*`, or `*.env`.
pub fn is_env_like(name: &str) -> bool {
    name == ".env" || name.starts_with(".env.") || name.ends_with(".env")
}

fn looks_like_sample(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["sample", "example", "template"].iter().any(|w| lower.contains(w))
}

/// Find all env-like file names directly inside the project dir, sorted.
pub fn scan(project_dir: &Path) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(project_dir)
        .map_err(|e| format!("Failed to read {}: {}", project_dir.display(), e))?;
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_env_like(n))
        .collect();
    names.sort();
    Ok(names)
}

/// Propose default original and sample names from the scanned list.
pub fn classify(names: &[String]) -> (Option<String>, Option<String>) {
    let sample = names.iter().find(|n| looks_like_sample(n)).cloned();
    let original = if names.iter().any(|n| n == ".env") {
        Some(".env".to_string())
    } else {
        names.iter().find(|n| !looks_like_sample(n)).cloned()
    };
    (original, sample)
}

/// Read one line from fd 0 without buffering: Rust's Stdin reads ahead in
/// 8KB chunks, which would swallow input meant for the sandboxed shell when
/// stdin is a pipe/script rather than a terminal.
fn read_line_unbuffered() -> String {
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    loop {
        let n = unsafe { libc::read(0, b.as_mut_ptr() as *mut libc::c_void, 1) };
        if n <= 0 || b[0] == b'\n' {
            break;
        }
        buf.push(b[0]);
    }
    String::from_utf8_lossy(&buf).to_string()
}

fn prompt_choice(role: &str, names: &[String], default: Option<&str>) -> Option<String> {
    println!("\nSelect the {} env file:", role);
    for (i, name) in names.iter().enumerate() {
        let marker = if Some(name.as_str()) == default { " (default)" } else { "" };
        println!("  {}. {}{}", i + 1, name, marker);
    }
    println!("  c. custom name");
    if role == "sample" {
        println!("  n. none");
    }
    let hint = default.unwrap_or(if role == "sample" { "none" } else { "skip" });
    print!("Choice [{}]: ", hint);
    let _ = std::io::stdout().flush();

    let line = read_line_unbuffered();
    let input = line.trim();
    if input.is_empty() {
        return default.map(String::from);
    }
    if input == "n" && role == "sample" {
        return None;
    }
    if input == "c" {
        print!("Enter file name: ");
        let _ = std::io::stdout().flush();
        let custom = read_line_unbuffered();
        let custom = custom.trim();
        if !custom.is_empty() {
            return Some(custom.to_string());
        }
        return default.map(String::from);
    }
    if let Ok(idx) = input.parse::<usize>()
        && idx >= 1 && idx <= names.len() {
            return Some(names[idx - 1].clone());
        }
    // Anything else: treat the input itself as a custom file name.
    Some(input.to_string())
}

/// Run detection + selection. `env_flag`/`sample_flag` (from --env/--sample)
/// skip the interactive picker for the corresponding role.
pub fn select(
    project_dir: &Path,
    env_flag: Option<String>,
    sample_flag: Option<String>,
) -> Result<EnvSelection, String> {
    let names = scan(project_dir)?;

    if names.is_empty() && env_flag.is_none() {
        eprintln!("vajra: no env files detected in {}; launching without env masking", project_dir.display());
        return Ok(EnvSelection { original: None, sample: None, masked: Vec::new() });
    }

    let (default_original, default_sample) = classify(&names);
    let default_sample = default_sample.or_else(|| Some(".sample.env".to_string()));

    let original = match env_flag {
        Some(name) => Some(name),
        None => prompt_choice("original (secrets)", &names, default_original.as_deref()),
    };
    let sample = match sample_flag {
        Some(name) => Some(name),
        None => prompt_choice("sample (visible to the agent)", &names, default_sample.as_deref()),
    };

    let masked = names
        .iter()
        .filter(|n| Some(n.as_str()) != sample.as_deref())
        .map(|n| project_dir.join(n))
        .collect();

    Ok(EnvSelection {
        original: original.map(|n| project_dir.join(n)),
        sample: sample.map(|n| project_dir.join(n)),
        masked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_like_matching() {
        assert!(is_env_like(".env"));
        assert!(is_env_like(".env.local"));
        assert!(is_env_like(".env.production"));
        assert!(is_env_like("dev.env"));
        assert!(is_env_like(".sample.env"));
        assert!(!is_env_like("package.json"));
        assert!(!is_env_like("environment.md"));
        assert!(!is_env_like(".envrc"));
    }

    #[test]
    fn classify_prefers_dot_env_and_sample_names() {
        let names: Vec<String> =
            [".env", ".env.local", ".env.example"].iter().map(|s| s.to_string()).collect();
        let (original, sample) = classify(&names);
        assert_eq!(original.as_deref(), Some(".env"));
        assert_eq!(sample.as_deref(), Some(".env.example"));
    }

    #[test]
    fn classify_falls_back_to_only_file() {
        let names: Vec<String> = ["prod.env"].iter().map(|s| s.to_string()).collect();
        let (original, sample) = classify(&names);
        assert_eq!(original.as_deref(), Some("prod.env"));
        assert_eq!(sample, None);
    }

    #[test]
    fn scan_finds_env_files() {
        let dir = std::env::temp_dir().join(format!("vajra-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in [".env", ".env.local", "package.json"] {
            std::fs::write(dir.join(f), "").unwrap();
        }
        let names = scan(&dir).unwrap();
        assert_eq!(names, vec![".env".to_string(), ".env.local".to_string()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
