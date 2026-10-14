use fuser::{
    FileAttr, FileType, Filesystem, KernelConfig, MountOption, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory,
    ReplyEmpty, ReplyEntry, ReplyOpen, ReplyWrite, Request, TimeOrNow,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{FromRawFd, IntoRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

const ROOT_INODE: u64 = 1;
const ENTRY_TTL: Duration = Duration::ZERO;
const CONTROL_FILES: [&str; 2] = [".vajra-sandbox.json", ".vajra-perms.json"];

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

fn open_beneath(root: &Path, relative: &str, flags: i32, mode: u32) -> Result<File, i32> {
    let root_c = std::ffi::CString::new(root.as_os_str().as_bytes()).map_err(|_| libc::EINVAL)?;
    let relative_c = std::ffi::CString::new(if relative.is_empty() { "." } else { relative }).map_err(|_| libc::EINVAL)?;
    let root_fd = unsafe { libc::open(root_c.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if root_fd < 0 { return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO)); }
    let how = OpenHow {
        flags: (flags | libc::O_CLOEXEC) as u64,
        mode: mode as u64,
        resolve: 0x08 | 0x04 | 0x02, // BENEATH, NO_SYMLINKS and NO_MAGICLINKS
    };
    let fd = unsafe { libc::syscall(libc::SYS_openat2, root_fd, relative_c.as_ptr(), &how, std::mem::size_of::<OpenHow>()) as i32 };
    let error = if fd < 0 { Some(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO)) } else { None };
    unsafe { libc::close(root_fd); }
    match error {
        Some(code) => Err(code),
        None => Ok(unsafe { File::from_raw_fd(fd) }),
    }
}

fn directory_names(root: &Path, relative: &str) -> Result<Vec<String>, i32> {
    let directory = open_beneath(root, relative, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    let raw = directory.into_raw_fd();
    let stream = unsafe { libc::fdopendir(raw) };
    if stream.is_null() {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO);
        unsafe { libc::close(raw); }
        return Err(code);
    }
    let mut names = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() { break; }
        let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." { continue; }
        if let Ok(name) = std::str::from_utf8(bytes) { names.push(name.to_string()); }
    }
    unsafe { libc::closedir(stream); }
    Ok(names)
}

fn parent_and_name(root: &Path, relative: &str) -> Result<(File, std::ffi::CString), i32> {
    let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    if name.is_empty() || name == "." || name == ".." { return Err(libc::EINVAL); }
    let directory = open_beneath(root, parent, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    let name = std::ffi::CString::new(name).map_err(|_| libc::EINVAL)?;
    Ok((directory, name))
}

fn unlink_beneath(root: &Path, relative: &str, flags: i32) -> Result<(), i32> {
    let (parent, name) = parent_and_name(root, relative)?;
    let result = unsafe { libc::unlinkat(std::os::fd::AsRawFd::as_raw_fd(&parent), name.as_ptr(), flags) };
    if result == 0 { Ok(()) } else { Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO)) }
}

fn rename_beneath(root: &Path, source: &str, destination: &str) -> Result<(), i32> {
    let (source_parent, source_name) = parent_and_name(root, source)?;
    let (destination_parent, destination_name) = parent_and_name(root, destination)?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            std::os::fd::AsRawFd::as_raw_fd(&source_parent), source_name.as_ptr(),
            std::os::fd::AsRawFd::as_raw_fd(&destination_parent), destination_name.as_ptr(),
            0u32,
        )
    };
    if result == 0 { Ok(()) } else { Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO)) }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Permissions {
    #[serde(default)]
    read: bool,
    #[serde(default)]
    write: bool,
    #[serde(default)]
    edit: bool,
    #[serde(default)]
    delete: bool,
}

impl Permissions {
    fn visible(&self) -> bool {
        self.read || self.write || self.edit || self.delete
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rule {
    pattern: String,
    read: Option<bool>,
    write: Option<bool>,
    edit: Option<bool>,
    delete: Option<bool>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPolicy {
    #[serde(default = "deny_all")]
    default_permissions: Permissions,
    #[serde(default)]
    file_rules: Vec<Rule>,
    #[serde(default)]
    environments: Option<HashMap<String, StoredPolicy>>,
}

fn deny_all() -> Permissions {
    Permissions { read: false, write: false, edit: false, delete: false }
}

impl StoredPolicy {
    fn load(path: &Path, environment: &str) -> Self {
        let Ok(metadata) = fs::symlink_metadata(path) else { return Self::deny_all_policy() };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Self::deny_all_policy();
        }
        let Ok(bytes) = fs::read(path) else { return Self::deny_all_policy() };
        let Ok(mut parsed) = serde_json::from_slice::<StoredPolicy>(&bytes) else {
            return Self::deny_all_policy();
        };
        if let Some(environments) = parsed.environments.take() {
            return environments
                .get(environment)
                .cloned()
                .unwrap_or_else(Self::deny_all_policy);
        }
        parsed
    }

    fn deny_all_policy() -> Self {
        Self { default_permissions: deny_all(), file_rules: Vec::new(), environments: None }
    }

    fn permissions(&self, path: &str) -> Permissions {
        let mut result = self.default_permissions.clone();
        for rule in &self.file_rules {
            let (negated, pattern) = match rule.pattern.strip_prefix('!') {
                Some(value) => (true, value),
                None => (false, rule.pattern.as_str()),
            };
            let matched = matches_glob(path, pattern);
            if matched ^ negated {
                if let Some(value) = rule.read { result.read = value; }
                if let Some(value) = rule.write { result.write = value; }
                if let Some(value) = rule.edit { result.edit = value; }
                if let Some(value) = rule.delete { result.delete = value; }
            }
        }
        result
    }
}

fn matches_glob(path: &str, pattern: &str) -> bool {
    let path_parts: Vec<&str> = path.split('/').collect();
    let pattern_parts: Vec<&str> = pattern.split('/').collect();
    match_segments(&path_parts, &pattern_parts, 0, 0)
}

fn match_segments(path: &[&str], pattern: &[&str], pi: usize, si: usize) -> bool {
    if si == pattern.len() { return pi == path.len(); }
    if pattern[si] == "**" {
        return (pi..=path.len()).any(|skip| match_segments(path, pattern, skip, si + 1));
    }
    pi < path.len()
        && match_segment(path[pi], pattern[si])
        && match_segments(path, pattern, pi + 1, si + 1)
}

fn match_segment(text: &str, pattern: &str) -> bool {
    let (mut ti, mut pi, mut star, mut retry) = (0, 0, None, 0);
    let text = text.as_bytes();
    let pattern = pattern.as_bytes();
    while ti < text.len() {
        if pi < pattern.len() && (pattern[pi] == b'?' || pattern[pi] == text[ti]) {
            ti += 1;
            pi += 1;
        } else if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            retry = ti;
        } else if let Some(star_at) = star {
            retry += 1;
            ti = retry;
            pi = star_at + 1;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == b'*' { pi += 1; }
    pi == pattern.len()
}

struct GuardedFs {
    root: PathBuf,
    policy_path: PathBuf,
    environment: String,
    inodes: Mutex<HashMap<u64, String>>,
    inode_ids: Mutex<HashMap<String, u64>>,
}

impl GuardedFs {
    fn new(root: PathBuf, policy_path: PathBuf, environment: String) -> Self {
        Self {
            root,
            policy_path,
            environment,
            inodes: Mutex::new(HashMap::from([(ROOT_INODE, String::new())])),
            inode_ids: Mutex::new(HashMap::from([(String::new(), ROOT_INODE)])),
        }
    }

    fn policy(&self) -> StoredPolicy { StoredPolicy::load(&self.policy_path, &self.environment) }

    fn rel_path(&self, inode: u64) -> Result<String, i32> {
        self.inodes.lock().unwrap().get(&inode).cloned().ok_or(libc::ENOENT)
    }

    fn inode(&self, path: &str) -> u64 {
        if let Some(id) = self.inode_ids.lock().unwrap().get(path).copied() { return id; }
        let mut ids = self.inode_ids.lock().unwrap();
        let id = ids.len() as u64 + ROOT_INODE;
        ids.insert(path.to_string(), id);
        self.inodes.lock().unwrap().insert(id, path.to_string());
        id
    }

    fn allowed_name(&self, path: &str) -> bool {
        if path.is_empty() { return true; }
        if path.split('/').any(|component| {
            (component.starts_with('.') && component != ".sample.env")
                || matches!(component, ".git" | "node_modules" | "target")
        }) {
            return false;
        }
        if CONTROL_FILES.contains(&path) || is_masked_name(path.rsplit('/').next().unwrap_or(path)) {
            return false;
        }
        if self.policy().permissions(path).visible() { return true; }
        self.directory_has_visible_child(path)
    }

    fn directory_has_visible_child(&self, path: &str) -> bool {
        let Ok(entries) = directory_names(&self.root, path) else { return false };
        entries.into_iter().any(|name| {
            let child = if path.is_empty() { name } else { format!("{path}/{name}") };
            let Ok(metadata) = open_beneath(&self.root, &child, libc::O_PATH, 0).and_then(|file| file.metadata().map_err(|e| e.raw_os_error().unwrap_or(libc::EIO))) else { return false };
            (metadata.is_dir() || metadata.is_file()) && self.allowed_name(&child)
        })
    }

    fn checked(&self, inode: u64, right: impl FnOnce(&Permissions) -> bool) -> Result<String, i32> {
        let relative = self.rel_path(inode)?;
        if !self.allowed_name(&relative) { return Err(libc::EACCES); }
        let permissions = self.policy().permissions(&relative);
        if !right(&permissions) { return Err(libc::EACCES); }
        open_beneath(&self.root, &relative, libc::O_PATH, 0)?;
        Ok(relative)
    }

    fn attr(&self, inode: u64, relative: &str) -> Result<FileAttr, i32> {
        let metadata = open_beneath(&self.root, relative, libc::O_PATH, 0)
            .and_then(|file| file.metadata().map_err(|e| e.raw_os_error().unwrap_or(libc::EIO)))?;
        let relative = self.rel_path(inode)?;
        if !self.allowed_name(&relative) { return Err(libc::EACCES); }
        let file_type = metadata.file_type();
        let kind = if file_type.is_dir() {
            FileType::Directory
        } else if file_type.is_file() {
            FileType::RegularFile
        } else if file_type.is_fifo() {
            return Err(libc::EACCES);
        } else {
            return Err(libc::EACCES);
        };
        let permissions = self.policy().permissions(&relative);
        let mode = if kind == FileType::Directory {
            0o755
        } else if permissions.write || permissions.edit {
            0o600
        } else {
            0o400
        };
        Ok(FileAttr {
            ino: inode,
            size: metadata.len(),
            blocks: metadata.blocks(),
            atime: SystemTime::UNIX_EPOCH + Duration::from_secs(metadata.atime().max(0) as u64),
            mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(metadata.mtime().max(0) as u64),
            ctime: SystemTime::UNIX_EPOCH + Duration::from_secs(metadata.ctime().max(0) as u64),
            crtime: SystemTime::UNIX_EPOCH,
            kind,
            perm: mode,
            nlink: metadata.nlink() as u32,
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            rdev: 0,
            blksize: metadata.blksize() as u32,
            flags: 0,
        })
    }

    fn create_attr(&self, relative: &str) -> Result<(u64, FileAttr), i32> {
        let inode = self.inode(relative);
        let attr = self.attr(inode, relative)?;
        Ok((inode, attr))
    }
}

fn is_masked_name(name: &str) -> bool {
    if name == ".env" { return true; }
    let Some(suffix) = name.strip_prefix(".env.") else { return false };
    !suffix.split('.').any(|segment| {
        ["example", "sample", "template", "defaults", "default", "dist"]
            .iter().any(|public| segment.eq_ignore_ascii_case(public))
    })
}

fn join_rel(parent: &str, name: &OsStr) -> Result<String, i32> {
    let name = name.to_str().ok_or(libc::EINVAL)?;
    if name.is_empty() || name == "." || name == ".." || name.contains('/') { return Err(libc::EINVAL); }
    Ok(if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") })
}

impl Filesystem for GuardedFs {
    fn init(&mut self, _req: &Request<'_>, _config: &mut KernelConfig) -> Result<(), i32> {
        crate::sandbox::apply_vfs_server_sandbox(&self.root).map_err(|_| libc::EPERM)
    }

    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let result = (|| {
            let parent_path = self.rel_path(parent)?;
            let relative = join_rel(&parent_path, name)?;
            if !self.allowed_name(&relative) { return Err(libc::ENOENT); }
            let (inode, attr) = self.create_attr(&relative)?;
            Ok((inode, attr))
        })();
        match result {
            Ok((_, attr)) => reply.entry(&ENTRY_TTL, &attr, 0),
            Err(code) => reply.error(code),
        }
    }

    fn getattr(&mut self, _req: &Request<'_>, inode: u64, _fh: Option<u64>, reply: ReplyAttr) {
        let result = self.rel_path(inode).and_then(|relative| self.attr(inode, &relative));
        match result { Ok(attr) => reply.attr(&ENTRY_TTL, &attr), Err(code) => reply.error(code) }
    }

    fn readdir(&mut self, _req: &Request<'_>, inode: u64, _fh: u64, offset: i64, mut reply: ReplyDirectory) {
        let result = (|| {
            let relative = self.rel_path(inode)?;
            if !self.allowed_name(&relative) { return Err(libc::EACCES); }
            open_beneath(&self.root, &relative, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            let mut entries = vec![(inode, FileType::Directory, ".".to_string()),
                (if inode == ROOT_INODE { ROOT_INODE } else { self.inode(Path::new(&relative).parent().unwrap_or(Path::new("")).to_str().unwrap_or("")) }, FileType::Directory, "..".to_string())];
            for name in directory_names(&self.root, &relative)? {
                let child = join_rel(&relative, OsStr::new(&name))?;
                if !self.allowed_name(&child) { continue; }
                let Ok(metadata) = open_beneath(&self.root, &child, libc::O_PATH, 0).and_then(|file| file.metadata().map_err(|e| e.raw_os_error().unwrap_or(libc::EIO))) else { continue };
                let kind = if metadata.is_dir() { FileType::Directory } else if metadata.is_file() { FileType::RegularFile } else { continue };
                entries.push((self.inode(&child), kind, name));
            }
            Ok(entries)
        })();
        match result {
            Ok(entries) => {
                for (index, (ino, kind, name)) in entries.into_iter().enumerate().skip(offset.max(0) as usize) {
                    if reply.add(ino, (index + 1) as i64, kind, name) { break; }
                }
                reply.ok();
            }
            Err(code) => reply.error(code),
        }
    }

    fn open(&mut self, _req: &Request<'_>, inode: u64, flags: i32, reply: ReplyOpen) {
        let write_access = flags & libc::O_ACCMODE != libc::O_RDONLY;
        let truncate = flags & libc::O_TRUNC != 0;
        let result = self.checked(inode, |p| if write_access { (p.write || p.edit) && (!truncate || p.write || p.edit) } else { p.read });
        match result {
            Ok(_) => reply.opened(inode, fuser::consts::FOPEN_DIRECT_IO),
            Err(code) => reply.error(code),
        }
    }

    fn read(&mut self, _req: &Request<'_>, inode: u64, _fh: u64, offset: i64, size: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyData) {
        let result = self.checked(inode, |p| p.read).and_then(|relative| {
            let mut file = open_beneath(&self.root, &relative, libc::O_RDONLY, 0)?;
            file.seek(SeekFrom::Start(offset.max(0) as u64)).map_err(|e| e.raw_os_error().unwrap_or(libc::EIO))?;
            let mut data = vec![0; size as usize];
            let len = file.read(&mut data).map_err(|e| e.raw_os_error().unwrap_or(libc::EIO))?;
            data.truncate(len);
            Ok(data)
        });
        match result { Ok(data) => reply.data(&data), Err(code) => reply.error(code) }
    }

    fn write(&mut self, _req: &Request<'_>, inode: u64, _fh: u64, offset: i64, data: &[u8], _write_flags: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyWrite) {
        let result = self.checked(inode, |p| p.write || p.edit).and_then(|relative| {
            let mut file = open_beneath(&self.root, &relative, libc::O_WRONLY, 0)?;
            file.seek(SeekFrom::Start(offset.max(0) as u64)).map_err(|e| e.raw_os_error().unwrap_or(libc::EIO))?;
            file.write(data).map_err(|e| e.raw_os_error().unwrap_or(libc::EIO))
        });
        match result { Ok(size) => reply.written(size as u32), Err(code) => reply.error(code) }
    }

    fn create(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, mode: u32, _umask: u32, _flags: i32, reply: ReplyCreate) {
        let result = (|| {
            let parent_path = self.rel_path(parent)?;
            let relative = join_rel(&parent_path, name)?;
            if !self.policy().permissions(&relative).write || CONTROL_FILES.contains(&relative.as_str()) || is_masked_name(name.to_str().unwrap_or("")) { return Err(libc::EACCES); }
            let file = open_beneath(&self.root, &relative, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, mode & 0o600)?;
            drop(file);
            self.create_attr(&relative).map(|(ino, attr)| (ino, attr))
        })();
        match result {
            Ok((ino, attr)) => reply.created(&ENTRY_TTL, &attr, 0, ino, fuser::consts::FOPEN_DIRECT_IO),
            Err(code) => reply.error(code),
        }
    }

    fn unlink(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let result = self.rel_path(parent).and_then(|p| join_rel(&p, name)).and_then(|relative| {
            if CONTROL_FILES.contains(&relative.as_str()) || is_masked_name(name.to_str().unwrap_or("")) || !self.policy().permissions(&relative).delete { return Err(libc::EACCES); }
            let metadata = open_beneath(&self.root, &relative, libc::O_PATH, 0)
                .and_then(|file| file.metadata().map_err(|e| e.raw_os_error().unwrap_or(libc::EIO)))?;
            if !metadata.is_file() { return Err(libc::EACCES); }
            unlink_beneath(&self.root, &relative, 0)
        });
        match result { Ok(()) => reply.ok(), Err(code) => reply.error(code) }
    }

    fn mkdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, mode: u32, _umask: u32, reply: ReplyEntry) {
        let result = self.rel_path(parent).and_then(|p| join_rel(&p, name)).and_then(|relative| {
            if CONTROL_FILES.contains(&relative.as_str()) || is_masked_name(name.to_str().unwrap_or(""))
                || !self.policy().permissions(&relative).write { return Err(libc::EACCES); }
            let (parent, name) = parent_and_name(&self.root, &relative)?;
            let result = unsafe { libc::mkdirat(std::os::fd::AsRawFd::as_raw_fd(&parent), name.as_ptr(), (mode & 0o700) as libc::mode_t) };
            if result != 0 { return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO)); }
            self.create_attr(&relative)
        });
        match result { Ok((_, attr)) => reply.entry(&ENTRY_TTL, &attr, 0), Err(code) => reply.error(code) }
    }

    fn rmdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let result = self.rel_path(parent).and_then(|p| join_rel(&p, name)).and_then(|relative| {
            if CONTROL_FILES.contains(&relative.as_str()) || is_masked_name(name.to_str().unwrap_or(""))
                || !self.policy().permissions(&relative).delete { return Err(libc::EACCES); }
            unlink_beneath(&self.root, &relative, libc::AT_REMOVEDIR)
        });
        match result { Ok(()) => reply.ok(), Err(code) => reply.error(code) }
    }

    fn rename(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, newparent: u64, newname: &OsStr, _flags: u32, reply: ReplyEmpty) {
        let result = (|| {
            let source_parent = self.rel_path(parent)?;
            let destination_parent = self.rel_path(newparent)?;
            let source = join_rel(&source_parent, name)?;
            let destination = join_rel(&destination_parent, newname)?;
            let policy = self.policy();
            if CONTROL_FILES.contains(&source.as_str()) || CONTROL_FILES.contains(&destination.as_str())
                || is_masked_name(name.to_str().unwrap_or(""))
                || is_masked_name(newname.to_str().unwrap_or(""))
                || !policy.permissions(&source).delete
                || !policy.permissions(&destination).write
            {
                return Err(libc::EACCES);
            }
            open_beneath(&self.root, &source, libc::O_PATH, 0)?;
            if open_beneath(&self.root, &destination, libc::O_PATH, 0).is_ok()
                && !policy.permissions(&destination).delete
            {
                return Err(libc::EACCES);
            }
            rename_beneath(&self.root, &source, &destination)
        })();
        match result { Ok(()) => reply.ok(), Err(code) => reply.error(code) }
    }

    fn setattr(&mut self, _req: &Request<'_>, inode: u64, _mode: Option<u32>, _uid: Option<u32>, _gid: Option<u32>, size: Option<u64>, _atime: Option<TimeOrNow>, _mtime: Option<TimeOrNow>, _ctime: Option<SystemTime>, _fh: Option<u64>, _crtime: Option<SystemTime>, _chgtime: Option<SystemTime>, _bkuptime: Option<SystemTime>, _flags: Option<u32>, reply: ReplyAttr) {
        let result = if let Some(size) = size {
            self.checked(inode, |p| p.edit || p.write).and_then(|relative| open_beneath(&self.root, &relative, libc::O_WRONLY, 0).and_then(|file| file.set_len(size).map_err(|e| e.raw_os_error().unwrap_or(libc::EIO))))
                .and_then(|()| self.rel_path(inode).and_then(|p| self.attr(inode, &p)))
        } else {
            Err(libc::EPERM)
        };
        match result { Ok(attr) => reply.attr(&ENTRY_TTL, &attr), Err(code) => reply.error(code) }
    }
}

#[napi]
pub fn mount_virtual_filesystem(project_dir: String, mountpoint: String, policy_path: String, environment: Option<String>) -> napi::Result<()> {
    let root = PathBuf::from(project_dir).canonicalize().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mountpoint = PathBuf::from(mountpoint);
    fs::create_dir_all(&mountpoint).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options = [MountOption::FSName("vajra-vfs".to_string()), MountOption::DefaultPermissions, MountOption::NoDev, MountOption::NoSuid];
    fuser::mount2(GuardedFs::new(root, PathBuf::from(policy_path), environment.unwrap_or_else(|| "default".to_string())), &mountpoint, &options)
        .map_err(|e| napi::Error::from_reason(format!("Could not mount Vajra VFS: {e}")))
}
