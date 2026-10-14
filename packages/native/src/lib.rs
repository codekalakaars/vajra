#![deny(clippy::all)]
// The #[napi] exports are reachable only through the generated Node bindings,
// which are not built for `cargo test`, so the test profile sees them as dead.
#![cfg_attr(test, allow(dead_code))]

// Vajra is Linux-only. Confinement is Landlock, a Linux LSM, and nothing
// equivalent exists elsewhere, so a non-Linux build would ship a binary that
// cannot do the one thing it exists to do. The JS entry points already refuse
// unsupported platforms (see packages/sandbox/src/platform.ts); this makes the
// refusal a build failure instead of a runtime surprise, so a stray
// `cargo build` on a Mac cannot quietly produce a macOS artifact.
#[cfg(not(target_os = "linux"))]
compile_error!("vajra-core targets Linux only; see packages/sandbox/src/platform.ts");

mod env;
mod envfile;
mod file;
mod path;
mod permissions;
mod process;
mod sandbox;
mod secret;
mod vfs;

/// Build the private shell root inside namespaces created by the launcher.
/// Only system runtime paths and the policy-filtered project mount enter its root.
#[napi]
pub fn prepare_protected_shell(root_dir: String, project_mount: String, runtime_binary: String) -> napi::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    fn fail(context: &str) -> napi::Error {
        napi::Error::from_reason(format!("{context}: {}", std::io::Error::last_os_error()))
    }
    fn cpath(path: &Path) -> napi::Result<CString> {
        CString::new(path.as_os_str().as_bytes()).map_err(|_| napi::Error::from_reason("A shell root path contains a NUL byte"))
    }
    fn bind(source: &Path, target: &Path, recursive: bool) -> napi::Result<()> {
        let source_c = cpath(source)?;
        let target_c = cpath(target)?;
        let flags = libc::MS_BIND | if recursive { libc::MS_REC } else { 0 };
        if unsafe { libc::mount(source_c.as_ptr(), target_c.as_ptr(), std::ptr::null(), flags, std::ptr::null()) } != 0 {
            return Err(fail("Could not mount a required shell path"));
        }
        Ok(())
    }

    let root = PathBuf::from(root_dir);
    let project = PathBuf::from(project_mount);
    let runtime = PathBuf::from(runtime_binary).canonicalize()
        .map_err(|error| napi::Error::from_reason(format!("Could not locate the Vajra shell runtime: {error}")))?;
    if !root.is_dir() || !project.is_dir() || !runtime.is_file() {
        return Err(napi::Error::from_reason("The protected shell root or project mount is missing"));
    }
    let slash = CString::new("/").expect("literal path");
    if unsafe { libc::mount(std::ptr::null(), slash.as_ptr(), std::ptr::null(), libc::MS_REC | libc::MS_PRIVATE, std::ptr::null()) } != 0 {
        return Err(fail("Could not make shell mounts private"));
    }
    let root_c = cpath(&root)?;
    if unsafe { libc::mount(root_c.as_ptr(), root_c.as_ptr(), std::ptr::null(), libc::MS_BIND | libc::MS_REC, std::ptr::null()) } != 0 {
        return Err(fail("Could not prepare the isolated shell root"));
    }

    for name in ["usr", "bin", "sbin", "lib", "lib64", "etc"] {
        let source = PathBuf::from("/").join(name);
        if source.exists() {
            bind(&source, &root.join(name), true)?;
        }
    }
    for name in ["null", "urandom", "random"] {
        let source = PathBuf::from("/dev").join(name);
        let target = root.join("dev").join(name);
        if source.exists() && target.exists() { bind(&source, &target, false)?; }
    }
    bind(&runtime, &root.join("runtime/node"), false)?;
    bind(&project, &root.join("project"), false)?;

    let proc_source = CString::new("proc").expect("literal filesystem name");
    let proc_target = cpath(&root.join("proc"))?;
    let proc_filesystem = CString::new("proc").expect("literal filesystem name");
    let proc_flags = libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC;
    if unsafe { libc::mount(proc_source.as_ptr(), proc_target.as_ptr(), proc_filesystem.as_ptr(), proc_flags, std::ptr::null()) } != 0 {
        return Err(fail("Could not mount the protected shell process view"));
    }

    let old_root = cpath(&root.join(".old_root"))?;
    if unsafe { libc::chdir(root_c.as_ptr()) } != 0 {
        return Err(fail("Could not enter the protected shell root"));
    }
    let dot = CString::new(".").expect("literal path");
    if unsafe { libc::syscall(libc::SYS_pivot_root, dot.as_ptr(), old_root.as_ptr()) } != 0 {
        return Err(fail("Could not isolate the shell filesystem root"));
    }
    if unsafe { libc::chdir(slash.as_ptr()) } != 0 {
        return Err(fail("Could not enter the protected shell root"));
    }
    let old_root_mount = CString::new("/.old_root").expect("literal path");
    if unsafe { libc::umount2(old_root_mount.as_ptr(), libc::MNT_DETACH) } != 0 {
        return Err(fail("Could not detach the host filesystem root"));
    }
    if unsafe { libc::rmdir(old_root_mount.as_ptr()) } != 0 {
        return Err(fail("Could not remove the detached host root"));
    }
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) } != 0 {
        return Err(fail("Could not tie the protected shell to its Vajra supervisor"));
    }
    Ok(())
}

#[macro_use]
extern crate napi_derive;

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
