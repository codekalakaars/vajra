use napi::Error;
use std::fs;
use std::path::Path;

#[napi]
pub fn read_file(path: String) -> Result<String, Error> {
    fs::read_to_string(&path).map_err(|e| Error::from_reason(format!("Failed to read file '{}': {}", path, e)))
}

#[napi]
pub fn write_file(path: String, content: String) -> Result<(), Error> {
    fs::write(&path, &content).map_err(|e| Error::from_reason(format!("Failed to write file '{}': {}", path, e)))
}

#[napi]
pub fn edit_file(path: String, old_string: String, new_string: String) -> Result<bool, Error> {
    let content = fs::read_to_string(&path)
        .map_err(|e| Error::from_reason(format!("Failed to read file '{}': {}", path, e)))?;
    
    if !content.contains(&old_string) {
        return Ok(false);
    }
    
    let new_content = content.replace(&old_string, &new_string);
    fs::write(&path, &new_content)
        .map_err(|e| Error::from_reason(format!("Failed to write file '{}': {}", path, e)))?;
    
    Ok(true)
}

#[napi]
pub fn delete_file(path: String) -> Result<(), Error> {
    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Ok(());
    }
    
    if path_obj.is_dir() {
        fs::remove_dir_all(&path)
            .map_err(|e| Error::from_reason(format!("Failed to delete directory '{}': {}", path, e)))?;
    } else {
        fs::remove_file(&path)
            .map_err(|e| Error::from_reason(format!("Failed to delete file '{}': {}", path, e)))?;
    }
    
    Ok(())
}

#[napi]
pub fn create_dir(path: String) -> Result<(), Error> {
    fs::create_dir_all(&path)
        .map_err(|e| Error::from_reason(format!("Failed to create directory '{}': {}", path, e)))
}

#[napi]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: i64,
}

#[napi]
pub fn list_files(path: String, recursive: Option<bool>) -> Result<Vec<FileEntry>, Error> {
    let recursive = recursive.unwrap_or(false);
    let mut entries = Vec::new();
    
    if recursive {
        list_files_recursive(&path, &mut entries)?;
    } else {
        list_files_flat(&path, &mut entries)?;
    }
    
    Ok(entries)
}

fn list_files_flat(path: &str, entries: &mut Vec<FileEntry>) -> Result<(), Error> {
    let dir = fs::read_dir(path)
        .map_err(|e| Error::from_reason(format!("Failed to read directory '{}': {}", path, e)))?;
    
    for entry in dir {
        let entry = entry.map_err(|e| Error::from_reason(format!("Failed to read entry: {}", e)))?;
        let metadata = entry.metadata()
            .map_err(|e| Error::from_reason(format!("Failed to read metadata: {}", e)))?;
        
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_file: metadata.is_file(),
            is_dir: metadata.is_dir(),
            size: metadata.len() as i64,
        });
    }
    
    Ok(())
}

fn list_files_recursive(path: &str, entries: &mut Vec<FileEntry>) -> Result<(), Error> {
    let dir = fs::read_dir(path)
        .map_err(|e| Error::from_reason(format!("Failed to read directory '{}': {}", path, e)))?;
    
    for entry in dir {
        let entry = entry.map_err(|e| Error::from_reason(format!("Failed to read entry: {}", e)))?;
        let metadata = entry.metadata()
            .map_err(|e| Error::from_reason(format!("Failed to read metadata: {}", e)))?;
        
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_file: metadata.is_file(),
            is_dir: metadata.is_dir(),
            size: metadata.len() as i64,
        });
        
        if metadata.is_dir() {
            list_files_recursive(&entry.path().to_string_lossy(), entries)?;
        }
    }
    
    Ok(())
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

#[napi]
pub fn copy_file(source: String, destination: String) -> Result<(), Error> {
    fs::copy(&source, &destination)
        .map_err(|e| Error::from_reason(format!("Failed to copy '{}' to '{}': {}", source, destination, e)))?;
    Ok(())
}

#[napi]
pub fn rename_file(source: String, destination: String) -> Result<(), Error> {
    fs::rename(&source, &destination)
        .map_err(|e| Error::from_reason(format!("Failed to rename '{}' to '{}': {}", source, destination, e)))?;
    Ok(())
}

#[napi]
pub fn file_size(path: String) -> Result<i64, Error> {
    let metadata = fs::metadata(&path)
        .map_err(|e| Error::from_reason(format!("Failed to read metadata for '{}': {}", path, e)))?;
    Ok(metadata.len() as i64)
}
