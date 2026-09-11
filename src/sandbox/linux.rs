//! Landlock LSM filesystem confinement.
//!
//! Ported from `legacy/src/landlock.rs`. The syscall plumbing, ABI detection
//! and permission-bit mapping are unchanged; what is new is that rules are
//! registered by absolute path. The legacy CLI passed project-relative paths
//! and relied on having chdir'd into the project first, which is not a
//! assumption a library called from Node can make.

use crate::permissions::{effective, FilePermissions, PermissionsConfig};
use crate::sandbox::{SandboxConfig, MAX_DEPTH};
use std::ffi::CString;
use std::path::Path;

#[cfg(target_arch = "x86_64")]
mod sysno {
    pub const LANDLOCK_CREATE_RULESET: i64 = 444;
    pub const LANDLOCK_ADD_RULE: i64 = 445;
    pub const LANDLOCK_RESTRICT_SELF: i64 = 446;
}

#[cfg(target_arch = "aarch64")]
mod sysno {
    // Landlock uses the same numbers on the generic syscall table that
    // aarch64 follows.
    pub const LANDLOCK_CREATE_RULESET: i64 = 444;
    pub const LANDLOCK_ADD_RULE: i64 = 445;
    pub const LANDLOCK_RESTRICT_SELF: i64 = 446;
}

use sysno::*;

const PR_SET_NO_NEW_PRIVS: i32 = 38;
const RULE_TYPE_PATH_BENEATH: i32 = 1;

#[repr(C)]
struct LandlockRulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

#[repr(C, packed)]
struct LandlockPathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

pub mod access {
    pub const EXECUTE: u64 = 1 << 0;
    pub const WRITE_FILE: u64 = 1 << 1;
    pub const READ_FILE: u64 = 1 << 2;
    pub const READ_DIR: u64 = 1 << 3;
    pub const REMOVE_DIR: u64 = 1 << 4;
    pub const REMOVE_FILE: u64 = 1 << 5;
    pub const MAKE_CHAR: u64 = 1 << 6;
    pub const MAKE_DIR: u64 = 1 << 7;
    pub const MAKE_REG: u64 = 1 << 8;
    pub const MAKE_SOCK: u64 = 1 << 9;
    pub const MAKE_FIFO: u64 = 1 << 10;
    pub const MAKE_BLOCK: u64 = 1 << 11;
    pub const MAKE_SYM: u64 = 1 << 12;
    pub const REFER: u64 = 1 << 13;
    pub const TRUNCATE: u64 = 1 << 14;
}

/// Directory-only rights. The kernel rejects a rule carrying any of these on a
/// non-directory target with EINVAL — READ_DIR is meaningless on a regular
/// file, for instance.
const DIR_ONLY_ACCESS: u64 = access::READ_DIR
    | access::REMOVE_DIR
    | access::REMOVE_FILE
    | access::MAKE_CHAR
    | access::MAKE_DIR
    | access::MAKE_REG
    | access::MAKE_SOCK
    | access::MAKE_FIFO
    | access::MAKE_BLOCK
    | access::MAKE_SYM
    | access::REFER;

/// Probe the Landlock ABI version. Err means the kernel has no Landlock at all.
pub fn detect_abi() -> Result<i32, String> {
    let ret = unsafe {
        libc::syscall(
            LANDLOCK_CREATE_RULESET,
            std::ptr::null::<LandlockRulesetAttr>(),
            0usize,
            1u32,
        )
    };

    if ret < 0 {
        Err("Landlock is not available on this kernel (needs 5.13+)".into())
    } else {
        Ok(ret as i32)
    }
}

/// Access bits the detected ABI can enforce.
///
/// A right the kernel does not know cannot go into a ruleset — it would be
/// rejected outright — so on an older kernel those operations are left
/// unrestricted rather than failing the whole sandbox. ABI 1 (5.13) lacks
/// REFER (cross-directory move/link); ABI 2 (5.19) lacks TRUNCATE (6.2+).
pub fn supported_bits(abi: i32) -> u64 {
    let mut mask = u64::MAX;
    if abi < 2 {
        mask &= !access::REFER;
    }
    if abi < 3 {
        mask &= !access::TRUNCATE;
    }
    mask
}

/// What an older ABI cannot enforce, phrased for a caller to surface.
pub fn degraded_note(abi: i32) -> Option<String> {
    match abi {
        a if a < 2 => Some(
            "kernel supports Landlock ABI 1 only: file-move (REFER) and truncate \
             restrictions are not enforced"
                .into(),
        ),
        2 => Some(
            "kernel supports Landlock ABI 2 only: truncate restrictions are not enforced".into(),
        ),
        _ => None,
    }
}

fn create_ruleset(handled: u64) -> Result<i32, String> {
    let attr = LandlockRulesetAttr {
        handled_access_fs: handled,
        handled_access_net: 0,
        scoped: 0,
    };

    let ret = unsafe {
        libc::syscall(
            LANDLOCK_CREATE_RULESET,
            &attr as *const _ as *const libc::c_void,
            std::mem::size_of::<LandlockRulesetAttr>(),
            0u32,
        )
    };

    if ret < 0 {
        Err("Failed to create Landlock ruleset".into())
    } else {
        Ok(ret as i32)
    }
}

fn add_path_rule(ruleset_fd: i32, path: &str, allowed: u64) -> Result<(), String> {
    let cpath = CString::new(path).map_err(|_| format!("Invalid path '{}'", path))?;

    let fd = unsafe { libc::open(cpath.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(format!("Failed to open path '{}'", path));
    }

    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let is_dir = unsafe { libc::fstat(fd, &mut stat) } == 0
        && (stat.st_mode & libc::S_IFMT) == libc::S_IFDIR;

    let allowed = if is_dir {
        allowed
    } else {
        allowed & !DIR_ONLY_ACCESS
    };

    let attr = LandlockPathBeneathAttr {
        allowed_access: allowed,
        parent_fd: fd,
    };

    let ret = unsafe {
        libc::syscall(
            LANDLOCK_ADD_RULE,
            ruleset_fd as i64,
            RULE_TYPE_PATH_BENEATH as i64,
            &attr as *const _ as *const libc::c_void,
            0u32,
        )
    };

    unsafe { libc::close(fd) };

    if ret != 0 {
        Err(format!("Failed to add Landlock rule for '{}'", path))
    } else {
        Ok(())
    }
}

/// Which rights have at least one per-path override that is stricter than the
/// project default.
///
/// Landlock rules are additive within a single ruleset: a grant on a
/// directory applies recursively to everything beneath it, and no narrower
/// rule on a descendant can revoke it. Two rights in this module are granted
/// without regard to depth and so are exposed to that leak:
///
///  - `READ_FILE` is requested whenever `perm.read` is set, independent of
///    `is_dir`. A directory-level grant (the project root, say) therefore
///    recursively exposes file content everywhere beneath it, including a
///    path whose own rule says `read: false`.
///  - `REMOVE_FILE`/`REMOVE_DIR` only exist at directory granularity — the
///    kernel rejects them on a file target (`DIR_ONLY_ACCESS`) — so the same
///    problem shows up one level up: a subdirectory that must not be
///    deletable cannot override an ancestor that grants delete.
///
/// When a right is narrowed like this, `perms_to_bits` withholds it from
/// every directory-level rule and relies entirely on each path's own
/// explicit rule, which `apply_per_file_rules` already adds for every file
/// and directory discovered in the walk. Nothing that exists at sandbox-apply
/// time loses access it should have. The trade-off: a path created *after*
/// the sandbox is applied gets no rule at all for that right until the
/// sandbox is reapplied, rather than silently inheriting the default. `apply`
/// surfaces this in its returned notes.
#[derive(Default)]
pub struct Narrowed {
    read: bool,
    delete: bool,
}

impl Narrowed {
    fn detect(perms: &PermissionsConfig) -> Self {
        let mut n = Narrowed::default();
        for file_perm in perms.files.values() {
            n.read |= perms.default.read && !file_perm.read;
            n.delete |= perms.default.delete && !file_perm.delete;
        }
        n
    }

    fn any(&self) -> bool {
        self.read || self.delete
    }
}

/// Translate one file's declared permissions into Landlock access bits.
pub fn perms_to_bits(perm: &FilePermissions, is_dir: bool, supported: u64, narrowed: &Narrowed) -> u64 {
    let mut bits = access::EXECUTE; // traversal

    if perm.read {
        // Listing is granted unconditionally: narrowing it only ever hides
        // filenames (this codebase already has a separate mechanism,
        // `is_masked`, for that), so it carries none of the recursive-leak
        // risk that content access does. READ_FILE is withheld on a
        // directory rule when some path in the tree needs `read: false` —
        // see `Narrowed`.
        bits |= access::READ_DIR;
        if !(is_dir && narrowed.read) {
            bits |= access::READ_FILE;
        }
    }

    if is_dir {
        if perm.write {
            bits |= access::MAKE_DIR | access::MAKE_REG | access::MAKE_SYM;
        }
        if perm.delete && !narrowed.delete {
            bits |= access::REMOVE_DIR | access::REMOVE_FILE;
        }
    } else {
        if perm.write {
            bits |= access::WRITE_FILE | access::MAKE_REG;
        }
        if perm.edit {
            bits |= access::TRUNCATE;
        }
        if perm.delete {
            bits |= access::REMOVE_FILE;
        }
    }

    bits & supported
}

fn should_skip_dir(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target")
}

/// Register one rule per path, using each path's declared permissions.
fn apply_per_file_rules(
    ruleset_fd: i32,
    project_dir: &Path,
    perms: &PermissionsConfig,
    supported: u64,
    notes: &mut Vec<String>,
) -> Result<(), String> {
    let narrowed = Narrowed::detect(perms);
    if narrowed.any() {
        notes.push(
            "a per-file rule narrows read or delete below the project default; paths created \
             after this sandbox is applied will not automatically inherit that right"
                .into(),
        );
    }

    // The project root itself needs a rule, or nothing beneath it is reachable.
    let root_bits = perms_to_bits(&perms.default, true, supported, &narrowed);
    add_path_rule(ruleset_fd, &project_dir.to_string_lossy(), root_bits)?;

    let mut stack: Vec<(std::path::PathBuf, u32)> = vec![(project_dir.to_path_buf(), 0)];

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

            // Never follow a symlink when building rules: the link's target may
            // sit outside the project entirely.
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            let rel = path
                .strip_prefix(project_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");

            let is_dir = file_type.is_dir();
            if is_dir && should_skip_dir(&name) {
                continue;
            }

            let perm = effective(perms, &rel);
            let bits = perms_to_bits(&perm, is_dir, supported, &narrowed);

            // Best-effort: a file removed between the walk and the rule add
            // should not abort the whole sandbox.
            let _ = add_path_rule(ruleset_fd, &path.to_string_lossy(), bits);

            if is_dir && depth < MAX_DEPTH {
                stack.push((path, depth + 1));
            }
        }
    }

    Ok(())
}

fn enforce(ruleset_fd: i32) -> Result<(), String> {
    let ret = unsafe { libc::syscall(LANDLOCK_RESTRICT_SELF, ruleset_fd as i64, 0u32) };
    if ret != 0 {
        Err("Failed to enforce Landlock ruleset".into())
    } else {
        Ok(())
    }
}

/// Apply Landlock to the calling process. Irreversible.
pub fn apply(config: &SandboxConfig) -> Result<(Vec<String>, Option<String>), String> {
    let abi = detect_abi()?;
    let supported = supported_bits(abi);
    let mut notes = Vec::new();

    let project_dir = Path::new(&config.project_dir);
    if !project_dir.is_dir() {
        return Err(format!(
            "Project directory '{}' does not exist",
            config.project_dir
        ));
    }

    let rw_all = (access::EXECUTE
        | access::WRITE_FILE
        | access::READ_FILE
        | access::READ_DIR
        | access::REMOVE_DIR
        | access::REMOVE_FILE
        | access::MAKE_CHAR
        | access::MAKE_DIR
        | access::MAKE_REG
        | access::MAKE_SOCK
        | access::MAKE_FIFO
        | access::MAKE_BLOCK
        | access::MAKE_SYM
        | access::REFER
        | access::TRUNCATE)
        & supported;

    let rx = access::EXECUTE | access::READ_FILE | access::READ_DIR;
    let ro = access::READ_FILE | access::READ_DIR;
    let rw = (access::READ_FILE
        | access::WRITE_FILE
        | access::READ_DIR
        | access::REMOVE_DIR
        | access::REMOVE_FILE
        | access::MAKE_DIR
        | access::MAKE_REG
        | access::TRUNCATE)
        & supported;

    // The ruleset must declare every right it intends to govern; anything not
    // handled here stays unrestricted regardless of the rules added below.
    let ruleset_fd = create_ruleset(rw_all)?;

    match &config.permissions {
        Some(perms) => apply_per_file_rules(ruleset_fd, project_dir, perms, supported, &mut notes)?,
        None => add_path_rule(ruleset_fd, &project_dir.to_string_lossy(), rw_all)?,
    }

    // System paths a process needs to keep functioning. Best-effort: a
    // distribution without /lib64 should not fail the sandbox.
    //
    // /tmp is deliberately absent. The legacy CLI granted it read-write, but
    // only because it also gave the sandbox a *private* /tmp via a mount
    // namespace. There is no namespace here, so granting it would expose the
    // real shared /tmp — every other process's scratch files — to the agent.
    // A caller that needs scratch space should pass a private directory in
    // readWritePaths.
    for (path, bits) in [
        ("/usr", rx),
        ("/bin", rx),
        ("/sbin", rx),
        ("/lib", rx),
        ("/lib64", rx),
        ("/etc", ro),
        ("/proc", ro),
        ("/dev", rw),
    ] {
        if Path::new(path).exists() && add_path_rule(ruleset_fd, path, bits).is_err() {
            notes.push(format!("could not add rule for {}", path));
        }
    }

    for dir in config.read_execute_paths.iter().flatten() {
        add_path_rule(ruleset_fd, dir, rx)?;
    }

    // Agent state dirs hold logs, tokens and session history — not binaries —
    // so they get read+write without execute.
    for dir in config.read_write_paths.iter().flatten() {
        add_path_rule(ruleset_fd, dir, rw)?;
    }

    // Required before restrict_self unless the process holds CAP_SYS_ADMIN.
    unsafe {
        libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    }

    enforce(ruleset_fd)?;

    Ok((notes, degraded_note(abi)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi1_drops_refer_and_truncate() {
        let mask = supported_bits(1);
        assert_eq!(mask & access::REFER, 0);
        assert_eq!(mask & access::TRUNCATE, 0);
        assert_ne!(mask & access::READ_FILE, 0);
        assert_ne!(mask & access::EXECUTE, 0);
    }

    #[test]
    fn abi2_drops_truncate_only() {
        let mask = supported_bits(2);
        assert_ne!(mask & access::REFER, 0);
        assert_eq!(mask & access::TRUNCATE, 0);
    }

    #[test]
    fn abi3_and_later_keep_everything() {
        assert_eq!(supported_bits(3), u64::MAX);
        assert_eq!(supported_bits(7), u64::MAX);
    }

    #[test]
    fn degraded_note_only_for_old_abis() {
        assert!(degraded_note(1).unwrap().contains("ABI 1"));
        assert!(degraded_note(2).unwrap().contains("truncate"));
        assert!(degraded_note(3).is_none());
    }

    fn perms(read: bool, write: bool, edit: bool, delete: bool) -> FilePermissions {
        FilePermissions {
            read,
            write,
            edit,
            delete,
        }
    }

    fn unnarrowed() -> Narrowed {
        Narrowed::default()
    }

    #[test]
    fn read_only_file_gets_no_write_bits() {
        let bits = perms_to_bits(&perms(true, false, false, false), false, u64::MAX, &unnarrowed());
        assert_ne!(bits & access::READ_FILE, 0);
        assert_eq!(bits & access::WRITE_FILE, 0);
        assert_eq!(bits & access::REMOVE_FILE, 0);
        assert_eq!(bits & access::TRUNCATE, 0);
    }

    #[test]
    fn writable_file_gets_write_and_edit_bits() {
        let bits = perms_to_bits(&perms(true, true, true, false), false, u64::MAX, &unnarrowed());
        assert_ne!(bits & access::WRITE_FILE, 0);
        assert_ne!(bits & access::TRUNCATE, 0);
        assert_eq!(bits & access::REMOVE_FILE, 0);
    }

    #[test]
    fn directory_write_grants_creation_not_file_write() {
        let bits = perms_to_bits(&perms(true, true, false, false), true, u64::MAX, &unnarrowed());
        assert_ne!(bits & access::MAKE_REG, 0);
        assert_ne!(bits & access::MAKE_DIR, 0);
        assert_eq!(bits & access::WRITE_FILE, 0);
    }

    #[test]
    fn unsupported_bits_are_masked_out() {
        // On an ABI-1 kernel a truncate grant must not survive into the ruleset.
        let bits = perms_to_bits(&perms(true, true, true, true), false, supported_bits(1), &unnarrowed());
        assert_eq!(bits & access::TRUNCATE, 0);
    }

    #[test]
    fn traversal_is_always_granted() {
        // Without EXECUTE on a directory nothing beneath it is reachable, even
        // when every declared permission is false.
        let bits = perms_to_bits(&perms(false, false, false, false), true, u64::MAX, &unnarrowed());
        assert_ne!(bits & access::EXECUTE, 0);
    }

    #[test]
    fn unread_directory_grants_no_dir_or_file_read() {
        // A directory with read: false must not expose listing or content,
        // regression coverage for the bit that used to be granted
        // unconditionally.
        let bits = perms_to_bits(&perms(false, false, false, false), true, u64::MAX, &unnarrowed());
        assert_eq!(bits & access::READ_DIR, 0);
        assert_eq!(bits & access::READ_FILE, 0);
    }

    #[test]
    fn narrowed_read_withholds_read_file_from_directories_but_not_listing() {
        let narrowed = Narrowed {
            read: true,
            delete: false,
        };
        let dir_bits = perms_to_bits(&perms(true, false, false, false), true, u64::MAX, &narrowed);
        assert_eq!(
            dir_bits & access::READ_FILE,
            0,
            "a directory rule must not recursively expose file content when a nested path needs read: false"
        );
        assert_ne!(
            dir_bits & access::READ_DIR,
            0,
            "listing is unaffected by the leak READ_FILE would cause"
        );
    }

    #[test]
    fn narrowed_read_does_not_affect_individual_files() {
        // A file's own rule never recurses, so narrowing elsewhere in the
        // tree must not touch what an individual file itself is granted.
        let narrowed = Narrowed {
            read: true,
            delete: false,
        };
        let file_bits = perms_to_bits(&perms(true, false, false, false), false, u64::MAX, &narrowed);
        assert_ne!(file_bits & access::READ_FILE, 0);
    }

    #[test]
    fn narrowed_delete_withholds_remove_bits_from_directories() {
        let narrowed = Narrowed {
            read: false,
            delete: true,
        };
        let dir_bits = perms_to_bits(&perms(true, false, false, true), true, u64::MAX, &narrowed);
        assert_eq!(dir_bits & access::REMOVE_DIR, 0);
        assert_eq!(dir_bits & access::REMOVE_FILE, 0);
    }

    #[test]
    fn detect_finds_read_and_delete_narrowing_independently() {
        let mut files = std::collections::HashMap::new();
        files.insert("secret.txt".to_string(), perms(false, false, false, true));

        let config = PermissionsConfig {
            version: 1,
            default: perms(true, false, false, true),
            files,
        };

        let narrowed = Narrowed::detect(&config);
        assert!(narrowed.read, "read: false below a read: true default must be detected");
        assert!(!narrowed.delete, "delete matches the default here, so nothing is narrowed");
        assert!(narrowed.any());
    }

    #[test]
    fn detect_finds_nothing_when_overrides_only_grant_more() {
        // The existing "per-file permissions deny writes to a read-only
        // file" integration test relies on this direction working exactly as
        // it did before: granting *more* than the default is not narrowing.
        let mut files = std::collections::HashMap::new();
        files.insert("writable.txt".to_string(), perms(true, true, true, false));

        let config = PermissionsConfig {
            version: 1,
            default: perms(true, false, false, false),
            files,
        };

        assert!(!Narrowed::detect(&config).any());
    }
}
