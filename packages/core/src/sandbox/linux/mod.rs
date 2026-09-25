mod permits;
pub(crate) mod syscall;

#[allow(unused_imports)]
pub use permits::{Narrowed, perms_to_bits};
#[allow(unused_imports)]
pub use syscall::access;

use crate::sandbox::SandboxConfig;
use std::path::Path;

use self::permits::apply_per_file_rules;
use self::syscall::{access as acc, add_path_rule, create_ruleset, enforce, PR_SET_NO_NEW_PRIVS};

pub fn detect_abi() -> Result<i32, String> {
    let ret = unsafe {
        libc::syscall(
            syscall::LANDLOCK_CREATE_RULESET,
            std::ptr::null::<syscall::LandlockRulesetAttr>(),
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

pub fn supported_bits(abi: i32) -> u64 {
    let mut mask = u64::MAX;
    if abi < 2 {
        mask &= !acc::REFER;
    }
    if abi < 3 {
        mask &= !acc::TRUNCATE;
    }
    mask
}

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

    let rw_all = (acc::EXECUTE
        | acc::WRITE_FILE
        | acc::READ_FILE
        | acc::READ_DIR
        | acc::REMOVE_DIR
        | acc::REMOVE_FILE
        | acc::MAKE_CHAR
        | acc::MAKE_DIR
        | acc::MAKE_REG
        | acc::MAKE_SOCK
        | acc::MAKE_FIFO
        | acc::MAKE_BLOCK
        | acc::MAKE_SYM
        | acc::REFER
        | acc::TRUNCATE)
        & supported;

    let rx = acc::EXECUTE | acc::READ_FILE | acc::READ_DIR;
    let ro = acc::READ_FILE | acc::READ_DIR;
    let rw = (acc::READ_FILE
        | acc::WRITE_FILE
        | acc::READ_DIR
        | acc::REMOVE_DIR
        | acc::REMOVE_FILE
        | acc::MAKE_DIR
        | acc::MAKE_REG
        | acc::TRUNCATE)
        & supported;

    let ruleset_fd = create_ruleset(rw_all)?;

    match &config.permissions {
        Some(perms) => apply_per_file_rules(ruleset_fd, project_dir, perms, supported, &mut notes)?,
        None => add_path_rule(ruleset_fd, &project_dir.to_string_lossy(), rw_all)?,
    }

    for (path, bits) in [
        ("/usr", rx),
        ("/bin", rx),
        ("/sbin", rx),
        ("/lib", rx),
        ("/lib64", rx),
        ("/etc", ro),
    ] {
        if Path::new(path).exists() && add_path_rule(ruleset_fd, path, bits).is_err() {
            notes.push(format!("could not add rule for {}", path));
        }
    }

    // 9.8: Narrow /proc to specific entries that toolchains need
    if Path::new("/proc").exists() {
        // Grant read access to /proc itself for basic process info
        let _ = add_path_rule(ruleset_fd, "/proc", ro);
        // Grant read access to /proc/self for the process's own info
        if Path::new("/proc/self").exists() {
            let _ = add_path_rule(ruleset_fd, "/proc/self", ro);
        }
        // Grant read access to /proc/cpuinfo for build tools
        if Path::new("/proc/cpuinfo").exists() {
            let _ = add_path_rule(ruleset_fd, "/proc/cpuinfo", ro);
        }
        // Grant read access to /proc/meminfo for build tools
        if Path::new("/proc/meminfo").exists() {
            let _ = add_path_rule(ruleset_fd, "/proc/meminfo", ro);
        }
    }

    // 9.8: Narrow /dev to individual device files with read/write only
    if Path::new("/dev").exists() {
        // Grant /dev/null for output redirection
        if Path::new("/dev/null").exists() {
            let _ = add_path_rule(ruleset_fd, "/dev/null", acc::READ_FILE | acc::WRITE_FILE);
        }
        // Grant /dev/urandom for randomness
        if Path::new("/dev/urandom").exists() {
            let _ = add_path_rule(ruleset_fd, "/dev/urandom", acc::READ_FILE);
        }
        // Grant /dev/random as fallback
        if Path::new("/dev/random").exists() {
            let _ = add_path_rule(ruleset_fd, "/dev/random", acc::READ_FILE);
        }
    }

    for dir in config.read_execute_paths.iter().flatten() {
        add_path_rule(ruleset_fd, dir, rx)?;
    }

    for dir in config.read_write_paths.iter().flatten() {
        add_path_rule(ruleset_fd, dir, rw)?;
    }

    unsafe {
        libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    }

    enforce(ruleset_fd)?;

    Ok((notes, degraded_note(abi)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{FilePermissions, PermissionsConfig};

    fn perms(read: bool, write: bool, edit: bool, delete: bool) -> FilePermissions {
        FilePermissions { read, write, edit, delete }
    }

    fn unnarrowed() -> Narrowed {
        Narrowed::default()
    }

    #[test]
    fn abi1_drops_refer_and_truncate() {
        let mask = supported_bits(1);
        assert_eq!(mask & acc::REFER, 0);
        assert_eq!(mask & acc::TRUNCATE, 0);
        assert_ne!(mask & acc::READ_FILE, 0);
        assert_ne!(mask & acc::EXECUTE, 0);
    }

    #[test]
    fn abi2_drops_truncate_only() {
        let mask = supported_bits(2);
        assert_ne!(mask & acc::REFER, 0);
        assert_eq!(mask & acc::TRUNCATE, 0);
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

    #[test]
    fn read_only_file_gets_no_write_bits() {
        let bits = perms_to_bits(&perms(true, false, false, false), false, u64::MAX, &unnarrowed());
        assert_ne!(bits & acc::READ_FILE, 0);
        assert_eq!(bits & acc::WRITE_FILE, 0);
        assert_eq!(bits & acc::REMOVE_FILE, 0);
        assert_eq!(bits & acc::TRUNCATE, 0);
    }

    #[test]
    fn writable_file_gets_write_and_edit_bits() {
        let bits = perms_to_bits(&perms(true, true, true, false), false, u64::MAX, &unnarrowed());
        assert_ne!(bits & acc::WRITE_FILE, 0);
        assert_ne!(bits & acc::TRUNCATE, 0);
        assert_eq!(bits & acc::REMOVE_FILE, 0);
    }

    #[test]
    fn directory_write_grants_creation_and_child_write() {
        // WRITE_FILE on a directory rule is required for open(O_WRONLY|O_CREAT)
        // of children — MAKE_REG alone is not enough on this kernel/Landlock ABI.
        let bits = perms_to_bits(&perms(true, true, false, false), true, u64::MAX, &unnarrowed());
        assert_ne!(bits & acc::MAKE_REG, 0);
        assert_ne!(bits & acc::MAKE_DIR, 0);
        assert_ne!(bits & acc::WRITE_FILE, 0);
    }

    #[test]
    fn unsupported_bits_are_masked_out() {
        let bits = perms_to_bits(&perms(true, true, true, true), false, supported_bits(1), &unnarrowed());
        assert_eq!(bits & acc::TRUNCATE, 0);
    }

    #[test]
    fn traversal_is_always_granted() {
        let bits = perms_to_bits(&perms(false, false, false, false), true, u64::MAX, &unnarrowed());
        assert_ne!(bits & acc::EXECUTE, 0);
    }

    #[test]
    fn unread_directory_grants_no_dir_or_file_read() {
        let bits = perms_to_bits(&perms(false, false, false, false), true, u64::MAX, &unnarrowed());
        assert_eq!(bits & acc::READ_DIR, 0);
        assert_eq!(bits & acc::READ_FILE, 0);
    }

    #[test]
    fn narrowed_read_withholds_read_file_from_directories_but_not_listing() {
        let narrowed = Narrowed { read: true, delete: false };
        let dir_bits = perms_to_bits(&perms(true, false, false, false), true, u64::MAX, &narrowed);
        assert_eq!(dir_bits & acc::READ_FILE, 0);
        assert_ne!(dir_bits & acc::READ_DIR, 0);
    }

    #[test]
    fn narrowed_read_does_not_affect_individual_files() {
        let narrowed = Narrowed { read: true, delete: false };
        let file_bits = perms_to_bits(&perms(true, false, false, false), false, u64::MAX, &narrowed);
        assert_ne!(file_bits & acc::READ_FILE, 0);
    }

    #[test]
    fn narrowed_delete_withholds_remove_bits_from_directories() {
        let narrowed = Narrowed { read: false, delete: true };
        let dir_bits = perms_to_bits(&perms(true, false, false, true), true, u64::MAX, &narrowed);
        assert_eq!(dir_bits & acc::REMOVE_DIR, 0);
        assert_eq!(dir_bits & acc::REMOVE_FILE, 0);
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
        assert!(narrowed.read);
        assert!(!narrowed.delete);
        assert!(narrowed.any());
    }

    #[test]
    fn detect_finds_nothing_when_overrides_only_grant_more() {
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
