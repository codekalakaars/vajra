use napi::Error;
use std::path::{Component, Path, PathBuf};

/// Resolve `.` and `..` textually, without touching the filesystem.
///
/// `Path::canonicalize` cannot be used for this: it requires the path to exist
/// and resolves symlinks. Callers frequently need to normalize a path they are
/// about to create, so normalization has to work on paths that are not there yet.
///
/// Because this is purely lexical it does not consult symlinks, so for an
/// existing path `a/link/..` may differ from what the kernel would resolve. Use
/// `realPath` when symlink-accurate resolution matters.
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                // Pop a real segment if there is one. At the root, `..` is the
                // root itself; on a relative path with nothing to pop, the `..`
                // has to be kept or the path changes meaning.
                let popped = matches!(
                    out.components().next_back(),
                    Some(Component::Normal(_))
                ) && out.pop();

                if !popped && !out.has_root() {
                    out.push("..");
                }
            }
            Component::Normal(segment) => out.push(segment),
        }
    }

    if out.as_os_str().is_empty() {
        out.push(".");
    }

    out
}

/// Make a path absolute against the current working directory and normalize it.
/// Does not require the path to exist.
#[napi]
pub fn resolve_path(path: String) -> Result<String, Error> {
    let path = Path::new(&path);

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let current_dir = std::env::current_dir().map_err(|e| {
            Error::from_reason(format!("Failed to get current directory: {}", e))
        })?;
        current_dir.join(path)
    };

    Ok(normalize_lexically(&absolute).to_string_lossy().to_string())
}

/// Lexically normalize a path. Works whether or not the path exists.
#[napi]
pub fn normalize_path(path: String) -> String {
    normalize_lexically(Path::new(&path))
        .to_string_lossy()
        .to_string()
}

/// Canonicalize a path via the filesystem, resolving symlinks.
/// The path must exist.
#[napi]
pub fn real_path(path: String) -> Result<String, Error> {
    Path::new(&path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| Error::from_reason(format!("Failed to resolve path '{}': {}", path, e)))
}

#[napi]
pub fn join_paths(base: String, relative: String) -> String {
    normalize_lexically(&Path::new(&base).join(&relative))
        .to_string_lossy()
        .to_string()
}

#[napi]
pub fn dirname(path: String) -> Option<String> {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
}

#[napi]
pub fn basename(path: String, ext: Option<String>) -> Option<String> {
    let file_name = Path::new(&path).file_name()?.to_string_lossy().to_string();

    let Some(ext) = ext else {
        return Some(file_name);
    };

    let suffix = if ext.starts_with('.') {
        ext
    } else {
        format!(".{}", ext)
    };

    // Only strip when something would remain: basename("a.txt", ".txt") is "a",
    // but basename(".txt", ".txt") must not become empty.
    match file_name.strip_suffix(&suffix) {
        Some(stem) if !stem.is_empty() => Some(stem.to_string()),
        _ => Some(file_name),
    }
}

#[napi]
pub fn extension(path: String) -> Option<String> {
    Path::new(&path)
        .extension()
        .map(|ext| ext.to_string_lossy().to_string())
}

#[napi]
pub fn is_absolute(path: String) -> bool {
    Path::new(&path).is_absolute()
}

#[napi]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[napi]
pub fn parent_path(path: String) -> Option<String> {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
}

/// Append `ext` unless the path already has an extension.
#[napi]
pub fn ensure_ext(path: String, ext: String) -> String {
    let path = Path::new(&path);

    if path.extension().is_some() {
        return path.to_string_lossy().to_string();
    }

    let suffix = if ext.starts_with('.') {
        ext
    } else {
        format!(".{}", ext)
    };

    format!("{}{}", path.display(), suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_without_touching_filesystem() {
        // None of these paths exist; the old implementation returned them verbatim.
        assert_eq!(normalize_path("/a/b/../c".into()), "/a/c");
        assert_eq!(normalize_path("/a/./b".into()), "/a/b");
        assert_eq!(normalize_path("a/b/../../c".into()), "c");
    }

    #[test]
    fn keeps_leading_parent_dirs_on_relative_paths() {
        // Dropping these would silently change which directory is meant.
        assert_eq!(normalize_path("../a".into()), "../a");
        assert_eq!(normalize_path("../../a".into()), "../../a");
        assert_eq!(normalize_path("a/../../b".into()), "../b");
    }

    #[test]
    fn parent_of_root_is_root() {
        assert_eq!(normalize_path("/..".into()), "/");
        assert_eq!(normalize_path("/../..".into()), "/");
    }

    #[test]
    fn empty_result_becomes_current_dir() {
        assert_eq!(normalize_path("a/..".into()), ".");
        assert_eq!(normalize_path(".".into()), ".");
    }

    #[test]
    fn join_normalizes_the_result() {
        assert_eq!(join_paths("/a/b".into(), "../c".into()), "/a/c");
    }

    #[test]
    fn resolve_makes_absolute_and_normalized() {
        let resolved = resolve_path("a/../b".into()).unwrap();
        assert!(Path::new(&resolved).is_absolute());
        assert!(resolved.ends_with("b"));
        assert!(!resolved.contains(".."));
    }

    #[test]
    fn basename_strips_extension_only_when_a_stem_remains() {
        assert_eq!(basename("/a/b.txt".into(), None), Some("b.txt".into()));
        assert_eq!(basename("/a/b.txt".into(), Some(".txt".into())), Some("b".into()));
        assert_eq!(basename("/a/b.txt".into(), Some("txt".into())), Some("b".into()));
        assert_eq!(basename("/a/b.txt".into(), Some(".md".into())), Some("b.txt".into()));
        // A dotfile whose whole name is the extension must survive intact.
        assert_eq!(basename("/a/.txt".into(), Some(".txt".into())), Some(".txt".into()));
    }

    #[test]
    fn ensure_ext_leaves_existing_extension_alone() {
        assert_eq!(ensure_ext("a".into(), "json".into()), "a.json");
        assert_eq!(ensure_ext("a".into(), ".json".into()), "a.json");
        assert_eq!(ensure_ext("a.toml".into(), "json".into()), "a.toml");
    }
}
