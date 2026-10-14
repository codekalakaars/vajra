//! The view: a project the guard serves itself.
//!
//! Landlock decides rights by adding them up, so a right granted to a folder covers
//! everything under it and no rule lower down can take it back. Three policies that need
//! the opposite — a name that is not listed at all, `delete` on one file, taking `write`
//! away from a folder that has it — cannot be expressed that way. This module serves the
//! project through a filesystem the guard owns instead, where each path is answered
//! individually.
//!
//! It replaces nothing: Landlock still denies the real project, the home directory and
//! everything else. The view decides what the command may do inside the project, and it
//! is only as trustworthy as its path handling, so every operation here resolves from
//! directory file descriptors, never from a path the kernel handed it, and refuses to
//! follow anything out of the project.

pub mod fs;

use crate::permissions::{effective, FilePermissions, PermissionsConfig};
use serde::Deserialize;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// What the view serves, and the rules it enforces. Built once by the guard from
/// `.vajra.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct ViewOptions {
    pub project_dir: String,
    pub permissions: PermissionsConfig,
    /// The policy file itself. It stays readable and unwritable whatever the file says,
    /// because a command that could rewrite its own rights is not confined.
    pub policy_file: String,
    /// Project-relative paths the command may not see the name of. `read: false` alone
    /// leaves the name visible, as it does under Landlock; `hidden` removes it.
    #[serde(default)]
    pub hidden: Vec<String>,
    /// Project-relative folders that are read and run only, whatever the file says.
    /// `.git`, `node_modules` and `target` are walked by nobody, so a rule inside them
    /// would be a rule nothing enforces.
    #[serde(default)]
    pub read_only_dirs: Vec<String>,
}

impl ViewOptions {
    /// The rights the view enforces for one project-relative path.
    pub fn rights(&self, rel: &str) -> FilePermissions {
        let mut perms = if self.read_only_dirs.iter().any(|dir| dir_covers(dir, rel)) {
            FilePermissions { read: true, write: false, edit: false, delete: false }
        } else {
            effective(&self.permissions, rel)
        };
        if !self.policy_file.is_empty() && rel == self.policy_file {
            perms.write = false;
            perms.edit = false;
            perms.delete = false;
        }
        perms
    }

    /// Whether the command may not see the name of this path.
    pub fn hidden(&self, rel: &str) -> bool {
        self.hidden.iter().any(|p| dir_covers(p, rel))
    }
}

/// Is `rel` the folder `dir`, or something inside it? A trailing slash on `dir` is
/// allowed, because that is how `.vajra.json` writes a folder.
pub fn dir_covers(dir: &str, rel: &str) -> bool {
    inside(dir.trim_end_matches('/'), rel)
}

/// Is `rel` the directory `dir`, or something inside it?
pub fn inside(dir: &str, rel: &str) -> bool {
    rel == dir || rel.starts_with(&format!("{dir}/"))
}

/// The parts of a project-relative path, with empty parts dropped.
pub fn split_rel(rel: &str) -> Vec<&str> {
    rel.split('/').filter(|part| !part.is_empty() && *part != ".").collect()
}

/// The project-relative path of the folder holding `rel`. Empty for a top-level path.
pub fn parent_rel(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(at) => &rel[..at],
        None => "",
    }
}

/// Joins a name onto a project-relative folder path.
pub fn join_rel(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

/// Normalises a project-relative path without touching the filesystem: `a/./b` and
/// `a/x/../b` both give `a/b`, and anything climbing above the project root is refused.
/// Used for symlink targets, which are strings the project's authors chose.
pub fn normalize_rel(rel: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for part in split_rel(rel) {
        if part == ".." {
            if out.pop().is_none() {
                return None;
            }
        } else {
            out.push(part);
        }
    }
    Some(out.join("/"))
}

/// The project-relative path a symlink names, or `None` if it leaves the project. `from`
/// is the folder the link sits in. A link is followed only inside the project: Landlock
/// denies the real project to the command, so one pointing out would show it something
/// it is otherwise kept from.
pub fn resolve_link(target: &str, from: &str, project: &Path) -> Option<String> {
    let as_path = Path::new(target);
    let joined = if as_path.is_absolute() {
        if !as_path.starts_with(project) {
            return None;
        }
        as_path.to_path_buf()
    } else {
        let mut base = PathBuf::from(project);
        for part in split_rel(from) {
            base.push(part);
        }
        base.push(target)
    };
    let inside = joined.strip_prefix(project).ok()?;
    normalize_rel(&inside.to_string_lossy())
}

/// Whether this machine can serve the view. A mount needs `/dev/fuse` and, unless the
/// process runs as root, the setuid `fusermount` helper to mount without a privilege.
pub fn capabilities() -> (bool, String) {
    if !Path::new("/dev/fuse").exists() {
        return (false, "/dev/fuse does not exist: no FUSE filesystem can be mounted here".into());
    }
    let helper = ["fusermount3", "fusermount"].into_iter().find(|name| {
        std::process::Command::new(name)
            .arg("--version")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    });
    match helper {
        Some(name) => (true, format!("{name} is here, so a view of the project can be mounted")),
        None => (false, "no fusermount or fusermount3: mounting needs one, unless running as root".into()),
    }
}

/// Stops the serving loop when the process is asked to end, so the mount is unmounted
/// rather than left behind. Rust's own signal handling would kill this process without
/// running the unmount.
static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_signal: i32) {
    STOP.store(true, Ordering::SeqCst);
}

/// Mounts the view at `mount_dir` and serves it until the process is signalled or the
/// filesystem is unmounted. Blocking: it is meant for a process of its own, because the
/// caller needs the real project open while the confined command only sees the view.
pub fn serve(opts: ViewOptions, mount_dir: &Path) -> io::Result<()> {
    let fs = fs::ViewFs::new(opts, mount_dir)?;
    let mut config = fuser::Config::default();
    config.n_threads = Some(4);
    let session = fuser::Session::new(fs, mount_dir, &config)?;
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as libc::sighandler_t);
        libc::signal(libc::SIGHUP, on_signal as libc::sighandler_t);
    }
    let background = session.spawn()?;
    while !STOP.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(50));
    }
    // Dropping the session unmounts.
    drop(background);
    Ok(())
}

/// Serves the view from Node's own process: `serve_view(mount_dir, json)` does not return
/// normally, because that process has nothing else to do until the guard is gone.
#[napi]
pub fn serve_view(mount_dir: String, options_json: String) -> Result<(), napi::Error> {
    let opts: ViewOptions = serde_json::from_str(&options_json)
        .map_err(|e| napi::Error::from_reason(format!("the view options are not valid JSON: {e}")))?;
    serve(opts, Path::new(&mount_dir)).map_err(|e| {
        napi::Error::from_reason(format!("could not serve the view at {}: {e}", mount_dir))
    })
}

/// Whether a view can be served here, in words.
#[napi]
pub fn view_capabilities() -> ViewCapabilities {
    let (supported, details) = capabilities();
    ViewCapabilities { supported, details }
}

#[napi(object)]
pub struct ViewCapabilities {
    pub supported: bool,
    pub details: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> ViewOptions {
        ViewOptions {
            project_dir: "/project".into(),
            permissions: crate::permissions::default_config(),
            policy_file: ".vajra.json".into(),
            hidden: vec![],
            read_only_dirs: vec![".git".into(), "node_modules".into(), "target".into()],
        }
    }

    #[test]
    fn a_link_inside_the_project_resolves_and_one_leaving_it_does_not() {
        let project = Path::new("/project");
        assert_eq!(resolve_link("../src/lib.rs", "src/bin", project).as_deref(), Some("src/lib.rs"));
        assert_eq!(resolve_link("./local", "src", project).as_deref(), Some("src/local"));
        assert_eq!(resolve_link("/project/src/lib.rs", "bin", project).as_deref(), Some("src/lib.rs"));
        // Out of the project, in either direction.
        assert_eq!(resolve_link("../../etc/passwd", "src/bin", project), None);
        assert_eq!(resolve_link("/etc/passwd", "src", project), None);
        assert_eq!(resolve_link("../..", "src", project), None);
        // A link to the project itself.
        assert_eq!(resolve_link("/project", "src", project).as_deref(), Some(""));
    }

    #[test]
    fn a_path_that_climbs_out_of_the_project_does_not_normalise() {
        assert_eq!(normalize_rel("a/./b").as_deref(), Some("a/b"));
        assert_eq!(normalize_rel("a/x/../b").as_deref(), Some("a/b"));
        assert_eq!(normalize_rel("").as_deref(), Some(""));
        assert_eq!(normalize_rel("../a"), None);
        assert_eq!(normalize_rel("a/../.."), None);
    }

    #[test]
    fn a_folder_covers_what_is_inside_it_and_nothing_beside_it() {
        assert!(inside(".git", ".git"));
        assert!(inside(".git", ".git/config"));
        assert!(!inside(".git", ".github"));
    }

    #[test]
    fn the_policy_file_is_never_writable_even_when_the_file_says_so() {
        let mut o = opts();
        o.permissions.files.insert(
            ".vajra.json".into(),
            FilePermissions { read: true, write: true, edit: true, delete: true },
        );
        let perms = o.rights(".vajra.json");
        assert!(perms.read);
        assert!(!perms.write);
        assert!(!perms.delete);
    }

    #[test]
    fn a_folder_that_is_walked_by_nobody_stays_read_only() {
        let mut o = opts();
        o.permissions.default = FilePermissions { read: true, write: true, edit: true, delete: true };
        let perms = o.rights("node_modules/pkg/index.js");
        assert!(perms.read);
        assert!(!perms.write);
        assert!(!perms.delete);
    }

    #[test]
    fn the_longest_folder_rule_decides_inside_the_project() {
        let mut o = opts();
        o.permissions.files.insert(
            "src/".into(),
            FilePermissions { read: true, write: true, edit: true, delete: false },
        );
        o.permissions.files.insert(
            "src/secret/".into(),
            FilePermissions { read: false, write: false, edit: false, delete: false },
        );
        assert!(o.rights("src/lib.rs").write);
        assert!(!o.rights("src/secret").read);
        assert!(!o.rights("srcs/lib.rs").write);
    }

    #[test]
    fn a_hidden_name_is_one_that_was_named_as_such() {
        let mut o = opts();
        o.hidden = vec!["secrets/".into()];
        assert!(o.hidden("secrets"));
        assert!(o.hidden("secrets/key.txt"));
        assert!(!o.hidden("src"));
    }
}
