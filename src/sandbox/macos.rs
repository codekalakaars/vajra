//! Seatbelt (`sandbox_init`) filesystem confinement for macOS.
//!
//! There is no Landlock equivalent on macOS, so this generates a Sandbox
//! Profile Language policy from the same `PermissionsConfig` and installs it on
//! the calling process.
//!
//! `sandbox_init` is formally deprecated by Apple in favour of App Sandbox
//! entitlements, which require a signed, bundled application. A CLI harness has
//! neither, and the SPI remains functional and is what `sandbox-exec` itself
//! uses. The deprecation is acknowledged rather than worked around.

use crate::permissions::effective;
use crate::sandbox::{SandboxConfig, MAX_DEPTH};
use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};

extern "C" {
    fn sandbox_init(profile: *const c_char, flags: u64, errorbuf: *mut *mut c_char) -> i32;
    fn sandbox_free_error(errorbuf: *mut c_char);
}

/// System locations a process needs readable to keep running at all: the dynamic
/// loader, shared caches, timezone and certificate data.
const SYSTEM_READ_PATHS: &[&str] = &[
    "/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc", "/private/var/db", "/opt",
];

fn should_skip_dir(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target")
}

/// The per-user container this process's temp directory lives in.
///
/// TMPDIR is `/var/folders/<xx>/<yyyy>/T/`; its parent holds both `T` and the
/// `C` cache directory, and macOS misbehaves without the latter. Resolving is
/// necessary because `/var` is a symlink to `/private/var` and a profile naming
/// the link governs nothing.
///
/// Falls back to the whole `/private/var/folders` tree when TMPDIR is unset or
/// has an unexpected shape — a broader grant is survivable, a process that
/// cannot reach its own cache is not. `apply` reports which one was used.
fn temp_container() -> String {
    const FALLBACK: &str = "/private/var/folders";

    let Some(tmpdir) = std::env::var_os("TMPDIR") else {
        return FALLBACK.to_string();
    };

    let resolved = match Path::new(&tmpdir).canonicalize() {
        Ok(p) => p,
        Err(_) => return FALLBACK.to_string(),
    };

    match resolved.parent() {
        Some(parent) if parent.starts_with("/private/var/folders") => {
            parent.to_string_lossy().to_string()
        }
        _ => FALLBACK.to_string(),
    }
}

/// Escape a path for inclusion in an SPL string literal.
///
/// Without this a path containing a quote or backslash would terminate the
/// literal early and change the meaning of the policy.
fn escape(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Build the profile for a config.
///
/// Split out from `apply` so it can be tested on any platform — the policy is
/// just text, and getting it wrong is the likeliest failure mode.
pub fn build_profile(config: &SandboxConfig, project_dir: &Path) -> String {
    let mut out = String::from(
        "(version 1)\n\
         (deny default)\n\
         ; Keep the process able to run: exec, fork, signal itself, look up\n\
         ; system services, and read sysctls. None of these grant file access.\n\
         (allow process-exec*)\n\
         (allow process-fork)\n\
         (allow signal (target self))\n\
         (allow sysctl-read)\n\
         (allow mach-lookup)\n\
         (allow ipc-posix-shm)\n\
         (allow file-read-metadata)\n\
         (allow network*)\n",
    );

    out.push_str("\n; System paths, read-only.\n");
    for path in SYSTEM_READ_PATHS {
        if Path::new(path).exists() {
            out.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", escape(path)));
        }
    }

    // /private/tmp and /private/var/tmp are deliberately absent: they are the
    // shared temp dirs, and granting them would expose every other process's
    // scratch files.
    out.push_str(
        "\n; Devices.\n\
         (allow file-read* file-write* (subpath \"/dev\"))\n",
    );

    // macOS and Node need this process's own per-user container (TMPDIR and the
    // sibling cache dir) to function. Granting all of /private/var/folders
    // would hand over every other session's caches too, so narrow it to just
    // this one.
    out.push_str("\n; This process's own temp and cache container.\n");
    out.push_str(&format!(
        "(allow file-read* file-write* (subpath \"{}\"))\n",
        escape(&temp_container())
    ));

    let project = escape(&project_dir.to_string_lossy());

    match &config.permissions {
        None => {
            out.push_str("\n; No per-file config: the whole project is read-write.\n");
            out.push_str(&format!(
                "(allow file-read* file-write* (subpath \"{}\"))\n",
                project
            ));
        }
        Some(perms) => {
            // Traversal into the project has to be possible before any rule
            // beneath it can matter.
            out.push_str("\n; Project root: the default, stated explicitly.\n");
            out.push_str(&format!(
                "(allow file-read-metadata (subpath \"{}\"))\n",
                project
            ));

            // State the denial rather than relying on the absence of a grant.
            // SBPL is last-match-wins, and an earlier broad allow — the temp
            // container, say — would otherwise silently supply the access the
            // default is meant to withhold. A project inside TMPDIR was fully
            // writable because of exactly that.
            let default_writable =
                perms.default.write || perms.default.edit || perms.default.delete;

            let verb = if perms.default.read { "allow" } else { "deny" };
            out.push_str(&format!("({} file-read* (subpath \"{}\"))\n", verb, project));

            let verb = if default_writable { "allow" } else { "deny" };
            out.push_str(&format!(
                "({} file-write* (subpath \"{}\"))\n",
                verb, project
            ));

            out.push_str("\n; Per-path overrides.\n");
            for (rel, path) in walk(project_dir) {
                let perm = effective(perms, &rel);
                let literal = escape(&path.to_string_lossy());
                let is_dir = path.is_dir();
                let selector = if is_dir { "subpath" } else { "literal" };

                // Emit a rule only where it differs from the default, so the
                // profile stays proportional to the overrides actually set.
                if perm.read != perms.default.read {
                    let verb = if perm.read { "allow" } else { "deny" };
                    out.push_str(&format!(
                        "({} file-read* ({} \"{}\"))\n",
                        verb, selector, literal
                    ));
                }

                let writable = perm.write || perm.edit || perm.delete;
                if writable != default_writable {
                    let verb = if writable { "allow" } else { "deny" };
                    out.push_str(&format!(
                        "({} file-write* ({} \"{}\"))\n",
                        verb, selector, literal
                    ));
                }
            }
        }
    }

    if let Some(paths) = &config.read_execute_paths {
        out.push_str("\n; Toolchain and caller-allowed paths, read+execute.\n");
        for dir in paths {
            out.push_str(&format!(
                "(allow file-read* (subpath \"{}\"))\n",
                escape(dir)
            ));
        }
    }

    if let Some(paths) = &config.read_write_paths {
        out.push_str("\n; Agent state dirs, read+write.\n");
        for dir in paths {
            out.push_str(&format!(
                "(allow file-read* file-write* (subpath \"{}\"))\n",
                escape(dir)
            ));
        }
    }

    out
}

/// Project-relative path and absolute path for every entry worth a rule.
fn walk(project_dir: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let mut stack: Vec<(PathBuf, u32)> = vec![(project_dir.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in read_dir.flatten() {
            let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            let is_dir = file_type.is_dir();
            if is_dir && should_skip_dir(&name) {
                continue;
            }

            let rel = path
                .strip_prefix(project_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");

            found.push((rel, path.clone()));

            if is_dir && depth < MAX_DEPTH {
                stack.push((path, depth + 1));
            }
        }
    }

    found
}

/// Apply the profile to the calling process. Irreversible.
pub fn apply(config: &SandboxConfig) -> Result<(Vec<String>, Option<String>), String> {
    let project_dir = Path::new(&config.project_dir);
    if !project_dir.is_dir() {
        return Err(format!(
            "Project directory '{}' does not exist",
            config.project_dir
        ));
    }

    // Rules must be written against the resolved path: /tmp is a symlink to
    // /private/tmp, and a profile naming the link governs nothing.
    let resolved = project_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve '{}': {}", config.project_dir, e))?;

    let profile = build_profile(config, &resolved);
    let c_profile =
        CString::new(profile).map_err(|_| "Profile contains an interior NUL byte".to_string())?;

    let mut errbuf: *mut c_char = std::ptr::null_mut();
    let ret = unsafe { sandbox_init(c_profile.as_ptr(), 0, &mut errbuf) };

    if ret != 0 {
        let message = if errbuf.is_null() {
            "sandbox_init failed".to_string()
        } else {
            let msg = unsafe { CStr::from_ptr(errbuf) }
                .to_string_lossy()
                .to_string();
            unsafe { sandbox_free_error(errbuf) };
            format!("sandbox_init failed: {}", msg)
        };
        return Err(message);
    }

    let container = temp_container();
    let mut warnings = vec![format!(
        "{} stays readable and writable: macOS needs this process's temp and \
         cache directory to function, so files beside the project within it are \
         not confined by this policy",
        container
    )];

    if container == "/private/var/folders" {
        warnings.push(
            "TMPDIR was unset or unrecognised, so the whole /private/var/folders \
             tree is granted rather than just this session's container"
                .into(),
        );
    }

    Ok((
        warnings,
        Some(
            "macOS confinement uses the deprecated sandbox_init SPI; process-level \
             only, and it cannot be lifted once applied"
                .into(),
        ),
    ))
}
