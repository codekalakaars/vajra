use std::fs;
use std::path::PathBuf;

use super::*;

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
    let n = edit_file(file.to_string_lossy().to_string(), "world".into(), "there".into(), None).unwrap();
    assert_eq!(n, 1);
    assert_eq!(fs::read_to_string(&file).unwrap(), "hello there");
}

#[test]
fn edit_rejects_ambiguous_match() {
    let dir = scratch("edit-ambiguous");
    let file = dir.join("a.txt");
    fs::write(&file, "x x").unwrap();
    let err = edit_file(file.to_string_lossy().to_string(), "x".into(), "y".into(), None).unwrap_err();
    assert!(err.reason.contains("occurs 2 times"));
    assert_eq!(fs::read_to_string(&file).unwrap(), "x x");
}

#[test]
fn edit_replace_all_rewrites_every_occurrence() {
    let dir = scratch("edit-all");
    let file = dir.join("a.txt");
    fs::write(&file, "x x").unwrap();
    let n = edit_file(file.to_string_lossy().to_string(), "x".into(), "y".into(), Some(true)).unwrap();
    assert_eq!(n, 2);
    assert_eq!(fs::read_to_string(&file).unwrap(), "y y");
}

#[test]
fn edit_errors_when_no_match() {
    let dir = scratch("edit-nomatch");
    let file = dir.join("a.txt");
    fs::write(&file, "hello").unwrap();
    let err = edit_file(file.to_string_lossy().to_string(), "absent".into(), "y".into(), None).unwrap_err();
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
    let err = copy_file(src.to_string_lossy().to_string(), dst.to_string_lossy().to_string(), None).unwrap_err();
    assert!(err.reason.contains("already exists"));
    assert_eq!(fs::read_to_string(&dst).unwrap(), "original");
}

#[test]
fn copy_file_overwrites_when_asked() {
    let dir = scratch("copy-overwrite");
    let src = dir.join("src.txt");
    let dst = dir.join("dst.txt");
    fs::write(&src, "new").unwrap();
    fs::write(&dst, "original").unwrap();
    copy_file(src.to_string_lossy().to_string(), dst.to_string_lossy().to_string(), Some(true)).unwrap();
    assert_eq!(fs::read_to_string(&dst).unwrap(), "new");
    assert!(src.exists());
}

#[test]
fn copy_file_to_a_new_path_needs_no_flag() {
    let dir = scratch("copy-new");
    let src = dir.join("src.txt");
    let dst = dir.join("dst.txt");
    fs::write(&src, "data").unwrap();
    copy_file(src.to_string_lossy().to_string(), dst.to_string_lossy().to_string(), None).unwrap();
    assert_eq!(fs::read_to_string(&dst).unwrap(), "data");
}

#[test]
fn rename_file_refuses_to_overwrite_by_default() {
    let dir = scratch("rename-refuse");
    let src = dir.join("src.txt");
    let dst = dir.join("dst.txt");
    fs::write(&src, "new").unwrap();
    fs::write(&dst, "original").unwrap();
    let err = rename_file(src.to_string_lossy().to_string(), dst.to_string_lossy().to_string(), None).unwrap_err();
    assert!(err.reason.contains("already exists"));
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
    rename_file(src.to_string_lossy().to_string(), dst.to_string_lossy().to_string(), Some(true)).unwrap();
    assert_eq!(fs::read_to_string(&dst).unwrap(), "new");
    assert!(!src.exists());
}

#[test]
fn rename_file_to_a_new_path_needs_no_flag() {
    let dir = scratch("rename-new");
    let src = dir.join("src.txt");
    let dst = dir.join("dst.txt");
    fs::write(&src, "data").unwrap();
    rename_file(src.to_string_lossy().to_string(), dst.to_string_lossy().to_string(), None).unwrap();
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
    let err = rename_file(src.to_string_lossy().to_string(), existing_dir.to_string_lossy().to_string(), None).unwrap_err();
    assert!(err.reason.contains("already exists"));
    assert!(rename_file(src.to_string_lossy().to_string(), existing_dir.to_string_lossy().to_string(), Some(true)).is_err());
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
    #[cfg(unix)]
    std::os::unix::fs::symlink(&dir, sub.join("loop")).unwrap();
    #[cfg(windows)]
    let _ = std::os::windows::fs::symlink_dir(&dir, sub.join("loop"));
    let entries = list_files(dir.to_string_lossy().to_string(), Some(true)).unwrap();
    assert!(entries.iter().any(|e| e.name == "f.txt"));
    #[cfg(unix)]
    {
        let link = entries.iter().find(|e| e.name == "loop").unwrap();
        assert!(link.is_symlink);
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
