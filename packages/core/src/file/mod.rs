mod async_tasks;
#[cfg(test)]
mod tests;

#[allow(unused_imports)]
pub use async_tasks::*;

use std::fs;
use std::path::{Path, PathBuf};

use napi::Error;

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

/// Returns the number of replacements made. Fails when `old_string` is absent
/// or occurs more than once (unless `replace_all` is set).
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

/// Errors if the path is a directory — use `delete_dir` instead.
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

/// Non-recursive by default — fails on non-empty directories.
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

/// Creates missing parents. Idempotent.
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

/// Symlinks are reported but never followed; depth capped at `MAX_DEPTH`.
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

            let file_type = entry
                .file_type()
                .map_err(|e| Error::from_reason(format!("Failed to read file type: {}", e)))?;

            let is_symlink = file_type.is_symlink();
            let is_dir = file_type.is_dir();
            let entry_path = entry.path();

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

/// Refuses to overwrite `destination` unless `overwrite` is set.
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

/// Refuses to overwrite `destination` unless `overwrite` is set.
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
