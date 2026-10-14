//! A seccomp filter that closes the ways around Landlock and the bubblewrap view.
//!
//! Landlock decides which paths a process may open, and the view decides which
//! paths exist. Neither stops a process from using a system call that works on
//! something else: tracing a process that is not confined, loading its own kernel
//! code, building a new mount or user namespace to rearrange what it sees, or
//! driving file operations through io_uring. This filter answers those with an
//! error. It runs after Landlock, and a child inherits it and cannot lift it.
//!
//! The filter denies a short list and allows the rest. It cannot look at a path,
//! because a path is a pointer in the process's memory, so it is never the thing
//! that decides which files are reachable.

use napi::Error;

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JEQ_K: u16 = 0x15;
const BPF_JGE_K: u16 = 0x35;
const BPF_JSET_K: u16 = 0x45;
const BPF_RET_K: u16 = 0x06;

const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;

/// Offsets into `struct seccomp_data`.
const OFFSET_NR: u32 = 0;
const OFFSET_ARCH: u32 = 4;
const OFFSET_ARG0: u32 = 16;
const OFFSET_ARG1: u32 = 24;

/// The ioctl that pushes a character into a terminal's input queue.
const TIOCSTI: u32 = 0x5412;

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xc000_003e;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xc000_00b7;

/// The calls that create a namespace, as `clone` flags.
const CLONE_NEW_MASK: u32 = 0x0002_0000 // NEWNS
    | 0x0200_0000 // NEWCGROUP
    | 0x0400_0000 // NEWUTS
    | 0x0800_0000 // NEWIPC
    | 0x1000_0000 // NEWUSER
    | 0x2000_0000 // NEWPID
    | 0x4000_0000; // NEWNET

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

#[repr(C)]
struct SockFprog {
    len: u16,
    filter: *const SockFilter,
}

const fn insn(code: u16, jt: u8, jf: u8, k: u32) -> SockFilter {
    SockFilter { code, jt, jf, k }
}

fn errno(code: i32) -> u32 {
    SECCOMP_RET_ERRNO | (code as u32 & 0xffff)
}

/// System calls that are answered with EPERM.
fn denied() -> Vec<libc::c_long> {
    let mut calls: Vec<libc::c_long> = vec![
        // Reaching into other processes, or code the kernel would run for us.
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_kexec_load,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_userfaultfd,
        // A second way to do file operations that the path rules never see. Only creating a ring
        // is refused: the guard's own Node process already holds one and keeps using it, and a
        // child cannot inherit it because libuv opens it close-on-exec.
        libc::SYS_io_uring_setup,
        // Opening a file by a handle skips the path altogether.
        libc::SYS_open_by_handle_at,
        // Rearranging the filesystem or the namespaces the view was built in.
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_open_tree,
        libc::SYS_move_mount,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_fspick,
        libc::SYS_mount_setattr,
        // Keys, the machine's state, and its clock.
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_acct,
        libc::SYS_settimeofday,
        libc::SYS_clock_settime,
        libc::SYS_clock_adjtime,
        libc::SYS_adjtimex,
        libc::SYS_sethostname,
        libc::SYS_setdomainname,
    ];
    #[cfg(target_arch = "x86_64")]
    calls.extend([libc::SYS_iopl, libc::SYS_ioperm, libc::SYS_modify_ldt]);
    calls
}

/// The filter program. Checks, in order: the architecture, the x32 bit, each denied call, the terminal ioctl, `clone3`, then `clone`'s flags.
pub fn build_filter() -> Vec<SockFilter> {
    let mut program: Vec<SockFilter> = Vec::new();

    // A call made through another architecture's table (the 32-bit entry on x86_64) would
    // dodge every number below, so such a process is stopped rather than filtered.
    program.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_ARCH));
    program.push(insn(BPF_JEQ_K, 1, 0, AUDIT_ARCH));
    program.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS));

    program.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_NR));
    #[cfg(target_arch = "x86_64")]
    {
        // The x32 ABI shares the architecture value and sets this bit in the number.
        program.push(insn(BPF_JGE_K, 0, 1, 0x4000_0000));
        program.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS));
    }

    for call in denied() {
        program.push(insn(BPF_JEQ_K, 0, 1, call as u32));
        program.push(insn(BPF_RET_K, 0, 0, errno(libc::EPERM)));
    }

    // TIOCSTI types into the terminal the shell is attached to. A shell in the view shares the
    // person's terminal, so without this a command could type into it as though they had.
    // This block reloads the accumulator, so it ends by loading the call number again.
    program.push(insn(BPF_JEQ_K, 0, 3, libc::SYS_ioctl as u32));
    program.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_ARG1));
    program.push(insn(BPF_JEQ_K, 0, 1, TIOCSTI));
    program.push(insn(BPF_RET_K, 0, 0, errno(libc::EPERM)));
    program.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_NR));

    // `clone3` takes its flags from a struct in memory, which the filter cannot read.
    // ENOSYS makes libc fall back to `clone`, whose flags it can.
    program.push(insn(BPF_JEQ_K, 0, 1, libc::SYS_clone3 as u32));
    program.push(insn(BPF_RET_K, 0, 0, errno(libc::ENOSYS)));

    // `clone` for a new namespace is refused; a plain fork or thread passes. This block
    // reloads the accumulator, so nothing that compares the call number may follow it.
    program.push(insn(BPF_JEQ_K, 0, 3, libc::SYS_clone as u32));
    program.push(insn(BPF_LD_W_ABS, 0, 0, OFFSET_ARG0));
    program.push(insn(BPF_JSET_K, 0, 1, CLONE_NEW_MASK));
    program.push(insn(BPF_RET_K, 0, 0, errno(libc::EPERM)));

    program.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
    program
}

#[napi]
/// Apply the filter to this process and everything it starts. It cannot be removed.
pub fn apply_seccomp() -> napi::Result<()> {
    let program = build_filter();
    let fprog = SockFprog { len: program.len() as u16, filter: program.as_ptr() };
    // Required to install a filter without privilege, and it also keeps a setuid program from gaining any.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(Error::from_reason(format!("Could not set no_new_privs: {}", std::io::Error::last_os_error())));
    }
    if unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &fprog as *const SockFprog) } != 0 {
        return Err(Error::from_reason(format!("Could not install the seccomp filter: {}", std::io::Error::last_os_error())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_jump_stays_inside_the_program() {
        let program = build_filter();
        for (index, step) in program.iter().enumerate() {
            let is_jump = step.code == BPF_JEQ_K || step.code == BPF_JGE_K || step.code == BPF_JSET_K;
            if !is_jump { continue; }
            let last = program.len() - 1;
            assert!(index + 1 + step.jt as usize <= last, "true branch at {index} leaves the program");
            assert!(index + 1 + step.jf as usize <= last, "false branch at {index} leaves the program");
        }
    }

    #[test]
    fn the_program_ends_by_allowing_and_fits_the_kernel_limit() {
        let program = build_filter();
        assert_eq!(program.last().map(|step| step.k), Some(SECCOMP_RET_ALLOW));
        assert!(program.len() <= 4096);
    }
}
