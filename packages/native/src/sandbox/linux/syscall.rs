use std::ffi::CString;

#[cfg(target_arch = "x86_64")]
mod sysno {
    pub const LANDLOCK_CREATE_RULESET: i64 = 444;
    pub const LANDLOCK_ADD_RULE: i64 = 445;
    pub const LANDLOCK_RESTRICT_SELF: i64 = 446;
}

#[cfg(target_arch = "aarch64")]
mod sysno {
    pub const LANDLOCK_CREATE_RULESET: i64 = 444;
    pub const LANDLOCK_ADD_RULE: i64 = 445;
    pub const LANDLOCK_RESTRICT_SELF: i64 = 446;
}

pub(crate) use sysno::*;

pub(crate) const PR_SET_NO_NEW_PRIVS: i32 = 38;
pub(crate) const RULE_TYPE_PATH_BENEATH: i32 = 1;

#[repr(C)]
pub(crate) struct LandlockRulesetAttr {
    pub handled_access_fs: u64,
    pub handled_access_net: u64,
    pub scoped: u64,
}

#[repr(C, packed)]
pub(crate) struct LandlockPathBeneathAttr {
    pub allowed_access: u64,
    pub parent_fd: i32,
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

pub(crate) const DIR_ONLY_ACCESS: u64 = access::READ_DIR
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

pub(crate) fn create_ruleset(handled: u64) -> Result<i32, String> {
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

pub(crate) fn add_path_rule(ruleset_fd: i32, path: &str, allowed: u64) -> Result<(), String> {
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

pub(crate) fn enforce(ruleset_fd: i32) -> Result<(), String> {
    let ret = unsafe { libc::syscall(LANDLOCK_RESTRICT_SELF, ruleset_fd as i64, 0u32) };
    if ret != 0 {
        Err("Failed to enforce Landlock ruleset".into())
    } else {
        Ok(())
    }
}
