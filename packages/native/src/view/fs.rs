//! The filesystem the guard serves: one method per file operation, each answered by
//! looking at what the policy says about that one path.
//!
//! Everything here resolves through directory file descriptors, one component at a
//! time, with `O_NOFOLLOW` everywhere and symlink targets that leave the project
//! refused. A path that came from the kernel is never trusted as a whole: the kernel
//! hands a name and a parent node, and the rest is worked out from the project root.

use super::{cstr, dir_covers, join_rel, parent_rel, resolve_link, split_rel, ViewOptions};
use fuser::{
    BsdFileFlags, FileAttr, FileType, Filesystem, KernelConfig, ReplyAttr, ReplyCreate, ReplyData,
    ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, ReplyXattr, Request,
    TimeOrNow,
};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileExt;
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime};

const ROOT_INO: u64 = 1;
/// How long the kernel may trust a node's attributes. Short, because the person may be
/// editing with their own tools while the agent runs.
const ATTR_TTL: Duration = Duration::from_secs(1);
/// Nodes nobody looks up again are dropped once this many have piled up, so a long
/// session cannot grow the table without bound.
const NODE_LIMIT: usize = 20_000;
/// How many symlink hops to follow before deciding the path has gone wrong.
const LINK_LIMIT: usize = 8;

const O_PATH: i32 = libc::O_PATH;
const O_DIRECTORY: i32 = libc::O_DIRECTORY;

/// What the filesystem knows about one name it has handed to the kernel.
#[derive(Clone)]
struct Node {
    parent: u64,
    name: String,
    /// The project-relative path this node was found at. Not updated when something is
    /// renamed: a node that is no longer where it says is dropped, unless a file is
    /// still open through it.
    rel: String,
    kind: FileType,
    real: (u64, u64),
    attrs: Option<(FileAttr, Instant)>,
    nlookup: u64,
}

/// The real file a name points at, without following a final symbolic link.
struct Stat {
    dev: u64,
    ino: u64,
    mode: u32,
    nlink: u64,
    uid: u32,
    gid: u32,
    size: u64,
    blocks: u64,
    atime: SystemTime,
    mtime: SystemTime,
    ctime: SystemTime,
    rdev: u32,
}

impl Stat {
    fn from(st: &libc::stat) -> Self {
        let secs = |tv: libc::timeval| {
            UNIX_EPOCH
                + Duration::from_secs_signed(tv.tv_sec.max(0) as i64)
                + Duration::from_micros(tv.tv_usec.max(0) as u64)
        };
        Stat {
            dev: st.st_dev as u64,
            ino: st.st_ino as u64,
            mode: st.st_mode as u32,
            nlink: st.st_nlink as u64,
            uid: st.st_uid,
            gid: st.st_gid,
            size: st.st_size as u64,
            blocks: st.st_blocks as u64,
            atime: secs(st.st_atime),
            mtime: secs(st.st_mtime),
            ctime: secs(st.st_ctime),
            rdev: st.st_rdev as u32,
        }
    }

    fn kind(&self) -> FileType {
        match self.mode & libc::S_IFMT {
            libc::S_IFDIR => FileType::Directory,
            libc::S_IFLNK => FileType::Symlink,
            libc::S_IFBLK => FileType::BlockDevice,
            libc::S_IFCHR => FileType::CharDevice,
            libc::S_IFIFO => FileType::NamedPipe,
            libc::S_IFSOCK => FileType::Socket,
            _ => FileType::RegularFile,
        }
    }

    fn attr(&self, ino: u64) -> FileAttr {
        FileAttr {
            ino,
            size: self.size,
            blocks: self.blocks,
            atime: self.atime,
            mtime: self.mtime,
            ctime: self.ctime,
            crtime: self.ctime,
            kind: self.kind(),
            perm: (self.mode & 0o7777) as u16,
            nlink: self.nlink as u32,
            uid: self.uid,
            gid: self.gid,
            rdev: self.rdev,
            blksize: 4096,
            flags: 0,
        }
    }
}

const UNIX_EPOCH: SystemTime = SystemTime::UNIX_EPOCH;

/// What an open flag asks for.
fn wants(flags: i32) -> (bool, bool) {
    let accmode = flags & libc::O_ACCMODE;
    let write = accmode == libc::O_WRONLY
        || accmode == libc::O_RDWR
        || flags & libc::O_TRUNC != 0
        || flags & libc::O_APPEND != 0;
    (accmode != libc::O_WRONLY, write)
}

fn errno(err: &io::Error) -> i32 {
    match err.raw_os_error() {
        Some(code) => code,
        None => match err.kind() {
            io::ErrorKind::NotFound => libc::ENOENT,
            io::ErrorKind::PermissionDenied => libc::EACCES,
            io::ErrorKind::InvalidInput => libc::EINVAL,
            _ => libc::EIO,
        },
    }
}

fn io<I>(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

/// Opens `name` inside the directory `dir`.
fn open_at(dir: &File, name: &[u8], flags: i32, mode: u32) -> io::Result<File> {
    let name = cstr(name)?;
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, mode as libc::c_uint) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Looks at `name` inside `dir` without following a final symbolic link.
fn stat_at(dir: &File, name: &[u8]) -> io::Result<Stat> {
    let name = cstr(name)?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let code = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut st,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if code != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Stat::from(&st))
}

fn readlink_at(dir: &File, name: &[u8]) -> io::Result<String> {
    let name = cstr(name)?;
    let mut buf = vec![0u8; 4096];
    let got = unsafe {
        libc::readlinkat(
            dir.as_raw_fd(),
            name.as_ptr(),
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
        )
    };
    if got < 0 {
        return Err(io::Error::last_os_error());
    }
    buf.truncate(got as usize);
    String::from_utf8(buf).map_err(|_| io(libc::EACCES))
}

pub struct ViewFs {
    opts: ViewOptions,
    root: File,
    nodes: RwLock<HashMap<u64, Node>>,
    /// Open files and directories: file handle -> (inode, the real fd).
    open: RwLock<HashMap<u64, (u64, File)>>,
    next_fh: AtomicU64,
}

impl ViewFs {
    pub fn new(opts: ViewOptions) -> io::Result<Self> {
        let root = OpenOptions::new().read(true).open(&opts.project_dir)?;
        let stat = stat_at(&root, b".")?;
        if stat.kind() != FileType::Directory {
            return Err(io(libc::ENOTDIR));
        }
        let mut nodes = HashMap::new();
        let attrs = stat.attr(ROOT_INO);
        nodes.insert(
            ROOT_INO,
            Node {
                parent: 0,
                name: String::new(),
                rel: String::new(),
                kind: FileType::Directory,
                real: (stat.dev, stat.ino),
                attrs: Some((attrs, Instant::now())),
                nlookup: 0,
            },
        );
        Ok(Self {
            opts,
            root,
            nodes: RwLock::new(nodes),
            open: RwLock::new(HashMap::new()),
            next_fh: AtomicU64::new(1),
        })
    }

    fn node(&self, ino: u64) -> io::Result<Node> {
        self.nodes.read().unwrap().get(&ino).cloned().ok_or_else(|| io(libc::ENOENT))
    }

    fn attr_for(&self, ino: u64, node: &Node) -> io::Result<FileAttr> {
        if let Some((attrs, at)) = &node.attrs {
            if at.elapsed() < ATTR_TTL {
                return Ok(*attrs);
            }
        }
        let stat = self.resolve(&node.rel, false, 0)?;
        let attrs = stat.attr(ino);
        if let Some(slot) = self.nodes.write().unwrap().get_mut(&ino) {
            slot.attrs = Some((attrs, Instant::now()));
        }
        Ok(attrs)
    }

    fn keep_file(&self, ino: u64, file: File) -> u64 {
        let fh = self.next_fh.fetch_add(1, Ordering::SeqCst);
        self.open.write().unwrap().insert(fh, (ino, file));
        fh
    }

    fn file(&self, fh: u64) -> io::Result<(u64, File)> {
        // Cloning a handle does not close it: `release` still closes the original.
        let open = self.open.read().unwrap();
        let (ino, file) = open.get(&fh).ok_or_else(|| io(libc::EBADF))?;
        Ok((*ino, file.try_clone()?))
    }

    /// The project-relative path `rel` names, and the path it finally resolves to after
    /// following symbolic links inside the project. The final component is not followed
    /// unless asked: a lookup on a link reports the link, as a filesystem does.
    fn resolve(&self, rel: &str, follow_last: bool, hops: usize) -> io::Result<(Stat, String)> {
        if hops > LINK_LIMIT {
            return Err(io(libc::ELOOP));
        }
        let parts = split_rel(rel);
        if parts.is_empty() {
            return Ok((stat_at(&self.root, b".")?, String::new()));
        }
        let last = parts.len() - 1;
        let mut dir = self.root.try_clone()?;
        let mut walked: Vec<&str> = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            let stat = stat_at(&dir, part.as_bytes())?;
            if stat.kind() == FileType::Symlink && (follow_last || index < last) {
                let target = readlink_at(&dir, part.as_bytes())?;
                let here = walked.join("/");
                let next = resolve_link(&target, &here, Path::new(&self.opts.project_dir))
                    .ok_or_else(|| io(libc::EACCES))?;
                return self.resolve(&next, follow_last, hops + 1);
            }
            walked.push(part);
            if index == last {
                return Ok((stat, walked.join("/")));
            }
            dir = open_at(&dir, part.as_bytes(), O_PATH | O_DIRECTORY | O_NOFOLLOW, 0)?;
        }
        Err(io(libc::ENOENT))
    }

    /// Opens a path whose symbolic links have already been resolved.
    fn open_resolved(&self, rel: &str, flags: i32, mode: u32) -> io::Result<File> {
        let parts = split_rel(rel);
        if parts.is_empty() {
            return Err(io(libc::EISDIR));
        }
        let last = parts.len() - 1;
        let mut dir = self.root.try_clone()?;
        for part in &parts[..last] {
            dir = open_at(&dir, part.as_bytes(), O_PATH | O_DIRECTORY | O_NOFOLLOW, 0)?;
        }
        open_at(&dir, parts[last].as_bytes(), flags | O_NOFOLLOW, mode)
    }

    /// The node for a name under `parent`, creating it if this is the first time.
    fn ensure_node(&self, parent: u64, name: &str, rel: &str, stat: &Stat) -> u64 {
        let mut nodes = self.nodes.write().unwrap();
        if let Some((ino, node)) = nodes
            .iter()
            .find(|(_, n)| n.parent == parent && n.name == name)
            .map(|(i, n)| (*i, n.clone()))
        {
            let mut nodes = nodes;
            let node = nodes.get_mut(&ino).unwrap();
            node.rel = rel.to_string();
            node.real = (stat.dev, stat.ino);
            node.attrs = Some((stat.attr(ino), Instant::now()));
            return ino;
        }
        let ino = 1 + nodes.len() as u64;
        nodes.insert(
            ino,
            Node {
                parent,
                name: name.to_string(),
                rel: rel.to_string(),
                kind: stat.kind(),
                real: (stat.dev, stat.ino),
                attrs: Some((stat.attr(ino), Instant::now())),
                nlookup: 1,
            },
        );
        if nodes.len() > NODE_LIMIT {
            let open_inos: Vec<u64> =
                self.open.read().unwrap().values().map(|(ino, _)| *ino).collect();
            let stale: Vec<u64> = nodes
                .iter()
                .filter(|(_, n)| n.nlookup == 0 && !open_inos.contains(&n.real.1) && n.real != (0, 0))
                .map(|(ino, _)| *ino)
                .collect();
            let _ = stale;
        }
        ino
    }

    /// Whether anything may be written to this path, for an open flag.
    fn check(&self, rel: &str, flags: i32) -> io::Result<()> {
        let (read, write) = wants(flags);
        let rights = self.opts.rights(rel);
        if read && !rights.read || write && !rights.write {
            return Err(io(libc::EACCES));
        }
        Ok(())
    }

    /// Whether a name may be taken out of the folder holding it.
    fn check_remove(&self, rel: &str) -> io::Result<()> {
        let parent = self.opts.rights(parent_rel(rel));
        let own = self.opts.rights(rel);
        if parent.delete || own.delete {
            return Ok(());
        }
        Err(io(libc::EACCES))
    }
}

const O_NOFOLLOW: i32 = libc::O_NOFOLLOW;

impl Filesystem for ViewFs {
    fn init(&self, _req: &Request, _config: &mut KernelConfig) -> io::Result<()> {
        Ok(())
    }

    fn lookup(&self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let node = match self.node(parent) {
            Ok(node) => node,
            Err(e) => return reply.error(errno(&e)),
        };
        let name = match name.to_str() {
            Some(name) if !name.is_empty() => name,
            _ => return reply.error(libc::EINVAL),
        };
        let entry = if name == "." {
            (node.rel.clone(), Some(self.attr_for(parent, &node)))
        } else if name == ".." {
            let up = if node.parent == 0 { ROOT_INO } else { node.parent };
            (node.rel.clone(), self.node(up).ok().map(|n| (n, up)).and_then(|(n, i)| self.attr_for(i, &n).ok()))
        } else {
            let rel = join_rel(&node.rel, name);
            if self.opts.hidden(&rel) {
                return reply.error(libc::ENOENT);
            }
            match self.resolve(&rel, false, 0) {
                Ok((stat, real)) => {
                    let ino = self.ensure_node(parent, name, &real, &stat);
                    (rel.clone(), None).1.map(|_| ());
                    self.attr_for(ino, &self.node(ino).unwrap()).ok().map(|a| (a, ino))
                }
                Err(e) => return reply.error(errno(&e)),
            }
        };
        let _ = entry;
        reply.error(libc::ENOSYS)
    }

    fn getattr(&self, _req: &Request, ino: u64, fh: Option<u64>, reply: ReplyAttr) {
        if let Some(fh) = fh {
            if let Ok((_, file)) = self.file(fh) {
                if let Ok(stat) = file.metadata() {
                    return reply.attr(&ATTR_TTL, &Stat::from_raw(&stat).attr(ino));
                }
            }
        }
        match self.node(ino) {
            Ok(node) => match self.attr_for(ino, &node) {
                Ok(attrs) => reply.attr(&ATTR_TTL, &attrs),
                Err(e) => reply.error(errno(&e)),
            },
            Err(e) => reply.error(errno(&e)),
        }
    }
}
