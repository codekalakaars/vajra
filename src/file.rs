use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Task};
use std::fs;
use std::path::{Path, PathBuf};

/// Maximum directory depth for recursive walks. Matches the cap the legacy
/// sandbox used (legacy/src/permissions.rs, legacy/src/landlock.rs) so the
/// native layer and the old Landlock rules agree on what "the project" is.
const MAX_DEPTH: u32 = 8;

#[napi]
pub fn read_file(path: String) -> Result<String, Error> {
    fs::read_to_string(&path)
        .map_err(|e| Error::from_reason(format!("Failed to read file '{}': {}", path, e)))
}

#[napi]
pub fn write_file(path: String, content: String) -> Result<(), Error> {
    fs::write(&path, &content)
        .map_err(|e| Error::from_reason(format!("Failed to write file '{}': {}", path, e)))
}

/// Replace `old_string` with `new_string` in a file.
///
/// Fails when `old_string` is absent, and — unless `replace_all` is set — when it
/// occurs more than once. An ambiguous match is a caller bug: silently rewriting
/// every occurrence is how an edit intended for one call site corrupts a file.
/// Returns the number of replacements made.
#[napi]
pub fn edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<u32, Error> {
    if old_string.is_empty() {
        return Err(Error::from_reason("old_string must not be empty"));
    }

    let replace_all = replace_all.unwrap_or(false);
    let content = fs::read_to_string(&path)
        .map_err(|e| Error::from_reason(format!("Failed to read file '{}': {}", path, e)))?;

    let count = content.matches(&old_string).count();
    if count == 0 {
        return Err(Error::from_reason(format!(
            "No match for old_string in '{}'",
            path
        )));
    }
    if count > 1 && !replace_all {
        return Err(Error::from_reason(format!(
            "old_string occurs {} times in '{}'; pass replaceAll to replace them all",
            count, path
        )));
    }

    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    fs::write(&path, &new_content)
        .map_err(|e| Error::from_reason(format!("Failed to write file '{}': {}", path, e)))?;

    Ok(count as u32)
}

/// Delete a single file. Errors if the path is a directory — use `deleteDir` for
/// that, so a recursive tree removal is always an explicit choice at the call site.
#[napi]
pub fn delete_file(path: String) -> Result<(), Error> {
    let target = Path::new(&path);

    if target.is_dir() {
        return Err(Error::from_reason(format!(
            "'{}' is a directory; use deleteDir",
            path
        )));
    }

    fs::remove_file(target)
        .map_err(|e| Error::from_reason(format!("Failed to delete file '{}': {}", path, e)))
}

/// Delete a directory. Non-recursive by default, so it fails on a non-empty
/// directory rather than destroying its contents.
#[napi]
pub fn delete_dir(path: String, recursive: Option<bool>) -> Result<(), Error> {
    let target = Path::new(&path);

    if target.is_file() {
        return Err(Error::from_reason(format!(
            "'{}' is a file; use deleteFile",
            path
        )));
    }

    let result = if recursive.unwrap_or(false) {
        fs::remove_dir_all(target)
    } else {
        fs::remove_dir(target)
    };

    result.map_err(|e| Error::from_reason(format!("Failed to delete directory '{}': {}", path, e)))
}

/// Create a directory, creating any missing parents. Idempotent: succeeds
/// silently if the directory already exists, rather than treating that as an
/// error the way a bare `mkdir` would.
#[napi]
pub fn create_dir(path: String) -> Result<(), Error> {
    fs::create_dir_all(&path)
        .map_err(|e| Error::from_reason(format!("Failed to create directory '{}': {}", path, e)))
}

#[napi(object)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: i64,
}

/// List directory contents, optionally recursing.
///
/// Symlinks are reported but never followed, and depth is capped at `MAX_DEPTH`.
/// Both matter: a symlink pointing at one of its own ancestors would otherwise
/// recurse until the stack overflows.
#[napi]
pub fn list_files(path: String, recursive: Option<bool>) -> Result<Vec<FileEntry>, Error> {
    let recursive = recursive.unwrap_or(false);
    let mut entries = Vec::new();
    let mut stack: Vec<(PathBuf, u32)> = vec![(PathBuf::from(&path), 0)];

    while let Some((dir, depth)) = stack.pop() {
        let read_dir = fs::read_dir(&dir).map_err(|e| {
            Error::from_reason(format!("Failed to read directory '{}': {}", dir.display(), e))
        })?;

        for entry in read_dir {
            let entry = entry
                .map_err(|e| Error::from_reason(format!("Failed to read entry: {}", e)))?;

            // file_type() comes from the directory entry and does not follow
            // symlinks; metadata() would, and would resolve a link to its target.
            let file_type = entry
                .file_type()
                .map_err(|e| Error::from_reason(format!("Failed to read file type: {}", e)))?;

            let is_symlink = file_type.is_symlink();
            let is_dir = file_type.is_dir();
            let entry_path = entry.path();

            // symlink_metadata describes the link itself, so a dangling symlink
            // is still listed rather than aborting the whole walk.
            let size = fs::symlink_metadata(&entry_path)
                .map(|m| m.len() as i64)
                .unwrap_or(0);

            entries.push(FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry_path.to_string_lossy().to_string(),
                is_file: file_type.is_file(),
                is_dir,
                is_symlink,
                size,
            });

            if recursive && is_dir && !is_symlink && depth < MAX_DEPTH {
                stack.push((entry_path, depth + 1));
            }
        }
    }

    Ok(entries)
}

#[napi]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[napi]
pub fn is_file(path: String) -> bool {
    Path::new(&path).is_file()
}

#[napi]
pub fn is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Copy a file. Refuses when `destination` already exists unless `overwrite`
/// is set — `fs::copy` replaces silently by default, which is exactly the kind
/// of surprise `editFile` and `deleteFile` already refuse elsewhere in this
/// module.
#[napi]
pub fn copy_file(
    source: String,
    destination: String,
    overwrite: Option<bool>,
) -> Result<(), Error> {
    if !overwrite.unwrap_or(false) && Path::new(&destination).exists() {
        return Err(Error::from_reason(format!(
            "'{}' already exists; pass overwrite to replace it",
            destination
        )));
    }

    fs::copy(&source, &destination).map_err(|e| {
        Error::from_reason(format!(
            "Failed to copy '{}' to '{}': {}",
            source, destination, e
        ))
    })?;
    Ok(())
}

/// Rename (move) a file. Refuses when `destination` already exists unless
/// `overwrite` is set.
///
/// This matters more than the same guard on `copyFile`: `std::fs::rename`
/// delegates to the OS, and POSIX and Windows have historically differed on
/// whether an existing destination is silently replaced or the call fails.
/// Checking explicitly here means the behavior is this function's choice, not
/// whatever the underlying platform happens to do.
#[napi]
pub fn rename_file(
    source: String,
    destination: String,
    overwrite: Option<bool>,
) -> Result<(), Error> {
    if !overwrite.unwrap_or(false) && Path::new(&destination).exists() {
        return Err(Error::from_reason(format!(
            "'{}' already exists; pass overwrite to replace it",
            destination
        )));
    }

    fs::rename(&source, &destination).map_err(|e| {
        Error::from_reason(format!(
            "Failed to rename '{}' to '{}': {}",
            source, destination, e
        ))
    })?;
    Ok(())
}

#[napi]
pub fn file_size(path: String) -> Result<i64, Error> {
    let metadata = fs::metadata(&path).map_err(|e| {
        Error::from_reason(format!("Failed to read metadata for '{}': {}", path, e))
    })?;
    Ok(metadata.len() as i64)
}

/// Async counterparts for the operations whose cost scales with the data.
///
/// Reading, writing and walking a tree can all take long enough to stall the
/// Node event loop; these run on the libuv threadpool instead. The cheap
/// predicates (`fileExists`, `isDir`, …) stay sync — dispatching them through a
/// threadpool would cost more than the call itself.
pub struct ReadFileTask {
    path: String,
}

impl Task for ReadFileTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        read_file(self.path.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<string>")]
pub fn read_file_async(path: String) -> AsyncTask<ReadFileTask> {
    AsyncTask::new(ReadFileTask { path })
}

pub struct WriteFileTask {
    path: String,
    content: String,
}

impl Task for WriteFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        write_file(self.path.clone(), self.content.clone())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi(ts_return_type = "Promise<void>")]
pub fn write_file_async(path: String, content: String) -> AsyncTask<WriteFileTask> {
    AsyncTask::new(WriteFileTask { path, content })
}

pub struct CopyFileTask {
    source: String,
    destination: String,
    overwrite: Option<bool>,
}

impl Task for CopyFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        copy_file(self.source.clone(), self.destination.clone(), self.overwrite)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi(ts_return_type = "Promise<void>")]
pub fn copy_file_async(
    source: String,
    destination: String,
    overwrite: Option<bool>,
) -> AsyncTask<CopyFileTask> {
    AsyncTask::new(CopyFileTask {
        source,
        destination,
        overwrite,
    })
}

pub struct ListFilesTask {
    path: String,
    recursive: Option<bool>,
}

impl Task for ListFilesTask {
    type Output = Vec<FileEntry>;
    type JsValue = Vec<FileEntry>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        list_files(self.path.clone(), self.recursive)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<Array<FileEntry>>")]
pub fn list_files_async(path: String, recursive: Option<bool>) -> AsyncTask<ListFilesTask> {
    AsyncTask::new(ListFilesTask { path, recursive })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a uniquely named scratch dir without pulling in a temp-dir crate.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vajra-file-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn edit_replaces_single_occurrence() {
        let dir = scratch("edit-single");
        let file = dir.join("a.txt");
        fs::write(&file, "hello world").unwrap();

        let n = edit_file(
            file.to_string_lossy().to_string(),
            "world".into(),
            "there".into(),
            None,
        )
        .unwrap();

        assert_eq!(n, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello there");
    }

    #[test]
    fn edit_rejects_ambiguous_match() {
        let dir = scratch("edit-ambiguous");
        let file = dir.join("a.txt");
        fs::write(&file, "x x").unwrap();

        let err = edit_file(
            file.to_string_lossy().to_string(),
            "x".into(),
            "y".into(),
            None,
        )
        .unwrap_err();
        assert!(err.reason.contains("occurs 2 times"));
        // File must be untouched when the edit is refused.
        assert_eq!(fs::read_to_string(&file).unwrap(), "x x");
    }

    #[test]
    fn edit_replace_all_rewrites_every_occurrence() {
        let dir = scratch("edit-all");
        let file = dir.join("a.txt");
        fs::write(&file, "x x").unwrap();

        let n = edit_file(
            file.to_string_lossy().to_string(),
            "x".into(),
            "y".into(),
            Some(true),
        )
        .unwrap();

        assert_eq!(n, 2);
        assert_eq!(fs::read_to_string(&file).unwrap(), "y y");
    }

    #[test]
    fn edit_errors_when_no_match() {
        let dir = scratch("edit-nomatch");
        let file = dir.join("a.txt");
        fs::write(&file, "hello").unwrap();

        let err = edit_file(
            file.to_string_lossy().to_string(),
            "absent".into(),
            "y".into(),
            None,
        )
        .unwrap_err();
        assert!(err.reason.contains("No match"));
    }

    #[test]
    fn delete_file_refuses_directory() {
        let dir = scratch("delete-dir-guard");
        let err = delete_file(dir.to_string_lossy().to_string()).unwrap_err();
        assert!(err.reason.contains("use deleteDir"));
        assert!(dir.is_dir());
    }

    #[test]
    fn delete_file_reports_missing_path() {
        let dir = scratch("delete-missing");
        let missing = dir.join("nope.txt");
        assert!(delete_file(missing.to_string_lossy().to_string()).is_err());
    }

    #[test]
    fn delete_dir_is_non_recursive_by_default() {
        let dir = scratch("delete-nonrecursive");
        let nested = dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("f.txt"), "x").unwrap();

        assert!(delete_dir(nested.to_string_lossy().to_string(), None).is_err());
        assert!(nested.is_dir());

        delete_dir(nested.to_string_lossy().to_string(), Some(true)).unwrap();
        assert!(!nested.exists());
    }

    #[test]
    fn create_dir_makes_missing_parents_and_is_idempotent() {
        let dir = scratch("create-dir");
        let nested = dir.join("a").join("b").join("c");

        create_dir(nested.to_string_lossy().to_string()).unwrap();
        assert!(nested.is_dir());

        // Calling again on an existing directory must not be an error.
        create_dir(nested.to_string_lossy().to_string()).unwrap();
    }

    #[test]
    fn create_dir_errors_when_a_file_occupies_the_path() {
        let dir = scratch("create-dir-blocked");
        let blocker = dir.join("blocker");
        fs::write(&blocker, "x").unwrap();

        assert!(create_dir(blocker.to_string_lossy().to_string()).is_err());
    }

    #[test]
    fn copy_file_refuses_to_overwrite_by_default() {
        let dir = scratch("copy-refuse");
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        fs::write(&src, "new").unwrap();
        fs::write(&dst, "original").unwrap();

        let err = copy_file(
            src.to_string_lossy().to_string(),
            dst.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();
        assert!(err.reason.contains("already exists"));
        // The refusal must be effective, not just reported.
        assert_eq!(fs::read_to_string(&dst).unwrap(), "original");
    }

    #[test]
    fn copy_file_overwrites_when_asked() {
        let dir = scratch("copy-overwrite");
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        fs::write(&src, "new").unwrap();
        fs::write(&dst, "original").unwrap();

        copy_file(
            src.to_string_lossy().to_string(),
            dst.to_string_lossy().to_string(),
            Some(true),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "new");
        // The source must survive a copy, unlike a rename.
        assert!(src.exists());
    }

    #[test]
    fn copy_file_to_a_new_path_needs_no_flag() {
        let dir = scratch("copy-new");
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        fs::write(&src, "data").unwrap();

        copy_file(
            src.to_string_lossy().to_string(),
            dst.to_string_lossy().to_string(),
            None,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "data");
    }

    #[test]
    fn rename_file_refuses_to_overwrite_by_default() {
        let dir = scratch("rename-refuse");
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        fs::write(&src, "new").unwrap();
        fs::write(&dst, "original").unwrap();

        let err = rename_file(
            src.to_string_lossy().to_string(),
            dst.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();
        assert!(err.reason.contains("already exists"));
        // Neither side should have moved.
        assert!(src.exists());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "original");
    }

    #[test]
    fn rename_file_overwrites_when_asked() {
        let dir = scratch("rename-overwrite");
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        fs::write(&src, "new").unwrap();
        fs::write(&dst, "original").unwrap();

        rename_file(
            src.to_string_lossy().to_string(),
            dst.to_string_lossy().to_string(),
            Some(true),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "new");
        // Unlike copy, the source must be gone after a rename.
        assert!(!src.exists());
    }

    #[test]
    fn rename_file_to_a_new_path_needs_no_flag() {
        let dir = scratch("rename-new");
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        fs::write(&src, "data").unwrap();

        rename_file(
            src.to_string_lossy().to_string(),
            dst.to_string_lossy().to_string(),
            None,
        )
        .unwrap();
        assert!(!src.exists());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "data");
    }

    #[test]
    fn rename_file_onto_an_existing_directory_errors_rather_than_merging() {
        let dir = scratch("rename-onto-dir");
        let src = dir.join("src.txt");
        let existing_dir = dir.join("existing_dir");
        fs::write(&src, "data").unwrap();
        fs::create_dir(&existing_dir).unwrap();

        // Without overwrite, this function's own guard refuses first.
        let err = rename_file(
            src.to_string_lossy().to_string(),
            existing_dir.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();
        assert!(err.reason.contains("already exists"));

        // With overwrite the guard steps aside, but the OS itself refuses to
        // replace a directory with a file (EISDIR) — a file replacing a
        // directory is not a rename this function should perform silently
        // under any flag.
        assert!(rename_file(
            src.to_string_lossy().to_string(),
            existing_dir.to_string_lossy().to_string(),
            Some(true),
        )
        .is_err());

        assert!(existing_dir.is_dir());
        assert!(src.exists());
    }

    #[test]
    fn file_size_matches_known_content_length() {
        let dir = scratch("file-size");
        let file = dir.join("a.txt");
        fs::write(&file, "hello").unwrap();

        assert_eq!(file_size(file.to_string_lossy().to_string()).unwrap(), 5);
    }

    #[test]
    fn file_size_errors_on_a_missing_path() {
        let dir = scratch("file-size-missing");
        let missing = dir.join("nope.txt");
        assert!(file_size(missing.to_string_lossy().to_string()).is_err());
    }

    #[test]
    fn list_files_does_not_follow_symlink_cycles() {
        let dir = scratch("symlink-cycle");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("f.txt"), "x").unwrap();

        // A symlink pointing back at its own ancestor. Following it would recurse
        // forever; the old implementation did exactly that.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&dir, sub.join("loop")).unwrap();
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_dir(&dir, sub.join("loop"));

        let entries = list_files(dir.to_string_lossy().to_string(), Some(true)).unwrap();
        assert!(entries.iter().any(|e| e.name == "f.txt"));

        #[cfg(unix)]
        {
            let link = entries.iter().find(|e| e.name == "loop").unwrap();
            assert!(link.is_symlink, "symlink must be reported as such");
        }
    }

    #[test]
    fn list_files_non_recursive_stays_shallow() {
        let dir = scratch("list-shallow");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(dir.join("top.txt"), "x").unwrap();
        fs::write(sub.join("deep.txt"), "x").unwrap();

        let entries = list_files(dir.to_string_lossy().to_string(), None).unwrap();
        assert!(entries.iter().any(|e| e.name == "top.txt"));
        assert!(!entries.iter().any(|e| e.name == "deep.txt"));
    }
}
