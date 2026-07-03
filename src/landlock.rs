use std::ffi::CString;

#[cfg(target_arch = "x86_64")]
mod sysno {
    pub const LANDLOCK_CREATE_RULESET: i64 = 444;
    pub const LANDLOCK_ADD_RULE: i64 = 445;
    pub const LANDLOCK_RESTRICT_SELF: i64 = 446;
}

use sysno::*;

const PR_SET_NO_NEW_PRIVS: i32 = 38;

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

mod access {
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

const RULE_TYPE_PATH_BENEATH: i32 = 1;

fn detect_abi() -> Result<i32, String> {
    let ret = unsafe {
        libc::syscall(
            LANDLOCK_CREATE_RULESET,
            std::ptr::null::<LandlockRulesetAttr>(),
            0usize,
            1u32,
        )
    };
    if ret < 0 {
        Err("Landlock not supported on this kernel".into())
    } else {
        Ok(ret as i32)
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

/// Directory-only rights: the kernel rejects a rule on a non-directory
/// target if any of these are present (EINVAL) — e.g. READ_DIR makes no
/// sense on a regular file like an allowlisted single config file.
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

fn add_path_rule(ruleset_fd: i32, path: &str, allowed: u64) -> Result<(), String> {
    let cpath = CString::new(path).map_err(|_| "Invalid path")?;
    let fd = unsafe { libc::open(cpath.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(format!("Failed to open path '{}'", path));
    }

    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let is_dir = unsafe { libc::fstat(fd, &mut stat) } == 0 && (stat.st_mode & libc::S_IFMT) == libc::S_IFDIR;
    let allowed = if is_dir { allowed } else { allowed & !DIR_ONLY_ACCESS };

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

fn enforce(ruleset_fd: i32) -> Result<(), String> {
    let ret = unsafe {
        libc::syscall(
            LANDLOCK_RESTRICT_SELF,
            ruleset_fd as i64,
            0u32,
        )
    };
    if ret != 0 {
        Err("Failed to enforce Landlock ruleset".into())
    } else {
        Ok(())
    }
}

/// Access bits the detected kernel ABI can enforce. Rights the kernel does
/// not know cannot go into a ruleset (it would be rejected), so on older
/// kernels those operations are left unrestricted rather than failing launch:
/// ABI 1 (5.13) lacks REFER (cross-directory move/link), ABI 2 (5.19) lacks
/// TRUNCATE (6.2+).
fn supported_bits(abi: i32) -> u64 {
    let mut mask = u64::MAX;
    if abi < 2 {
        mask &= !access::REFER;
    }
    if abi < 3 {
        mask &= !access::TRUNCATE;
    }
    mask
}

fn warn_degraded(abi: i32) {
    if abi < 3 {
        let missing = if abi < 2 { "file-move and truncate" } else { "truncate" };
        eprintln!(
            "vajra: kernel supports Landlock ABI {} only; {} restrictions unavailable",
            abi, missing
        );
    }
}

pub fn restrict_filesystem(
    project_dir: &str,
    extra_rx: &[String],
    extra_rw: &[String],
) -> Result<(), String> {
    let abi = detect_abi()?;
    warn_degraded(abi);
    let supported = supported_bits(abi);

    let rw_all = access::EXECUTE
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
        | access::TRUNCATE;
    let rw_all = rw_all & supported;

    let rx = access::EXECUTE | access::READ_FILE | access::READ_DIR;

    let rw = (access::READ_FILE | access::WRITE_FILE | access::READ_DIR | access::REMOVE_DIR | access::REMOVE_FILE | access::MAKE_DIR | access::MAKE_REG | access::TRUNCATE) & supported;

    let ro = access::READ_FILE | access::READ_DIR;

    let ruleset_fd = create_ruleset(rw_all)?;

    add_path_rule(ruleset_fd, project_dir, rw_all)?;
    add_path_rule(ruleset_fd, "/usr", rx)?;
    add_path_rule(ruleset_fd, "/lib", rx)?;
    add_path_rule(ruleset_fd, "/lib64", rx)?;
    add_path_rule(ruleset_fd, "/proc", ro)?;
    // System config: OpenSSL config, CA certs, resolv.conf, timezone data.
    // Read-only; root-only files inside stay protected by file permissions.
    add_path_rule(ruleset_fd, "/etc", ro)?;
    add_path_rule(ruleset_fd, "/dev", rw)?;
    add_path_rule(ruleset_fd, "/tmp", rw)?;

    // Allow executing the sibling vajra-run client from inside the sandbox
    // even when the install dir lives outside the paths above.
    if let Ok(exe) = std::fs::read_link("/proc/self/exe")
        && let Some(dir) = exe.parent().and_then(|d| d.to_str()) {
            let _ = add_path_rule(ruleset_fd, dir, rx);
        }

    // Toolchain and user-allowed dirs (--allow): read+execute only.
    for dir in extra_rx {
        add_path_rule(ruleset_fd, dir, rx)?;
    }

    // Agent state dirs and user-allowed dirs (--allow-rw): read+write, no
    // execute — these hold logs, auth tokens, and session history, not binaries.
    for dir in extra_rw {
        add_path_rule(ruleset_fd, dir, rw)?;
    }

    unsafe {
        libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    }

    enforce(ruleset_fd)
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
}
