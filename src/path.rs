use napi::Error;
use std::path::Path;

#[napi]
pub fn resolve_path(path: String) -> Result<String, Error> {
    let path = Path::new(&path);
    
    if path.is_absolute() {
        return Ok(path.to_string_lossy().to_string());
    }
    
    let current_dir = std::env::current_dir()
        .map_err(|e| Error::from_reason(format!("Failed to get current directory: {}", e)))?;
    
    let resolved = current_dir.join(&path);
    Ok(resolved.to_string_lossy().to_string())
}

#[napi]
pub fn normalize_path(path: String) -> Result<String, Error> {
    let path = Path::new(&path);
    
    if !path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    
    let canonical = path.canonicalize()
        .map_err(|e| Error::from_reason(format!("Failed to canonicalize path '{}': {}", path.display(), e)))?;
    
    Ok(canonical.to_string_lossy().to_string())
}

#[napi]
pub fn join_paths(base: String, relative: String) -> String {
    let base = Path::new(&base);
    let joined = base.join(&relative);
    joined.to_string_lossy().to_string()
}

#[napi]
pub fn dirname(path: String) -> Option<String> {
    let path = Path::new(&path);
    path.parent().map(|p| p.to_string_lossy().to_string())
}

#[napi]
pub fn basename(path: String, ext: Option<String>) -> Option<String> {
    let path = Path::new(&path);
    let file_name = path.file_name()?.to_string_lossy().to_string();
    
    match ext {
        Some(ext) => {
            let ext_with_dot = if ext.starts_with('.') {
                ext
            } else {
                format!(".{}", ext)
            };
            
            if file_name.ends_with(&ext_with_dot) {
                Some(file_name[..file_name.len() - ext_with_dot.len()].to_string())
            } else {
                Some(file_name)
            }
        }
        None => Some(file_name),
    }
}

#[napi]
pub fn extension(path: String) -> Option<String> {
    let path = Path::new(&path);
    path.extension().map(|ext| ext.to_string_lossy().to_string())
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
    let path = Path::new(&path);
    path.parent().map(|p| p.to_string_lossy().to_string())
}

#[napi]
pub fn ensure_ext(path: String, ext: String) -> String {
    let path = Path::new(&path);
    
    if path.extension().is_some() {
        return path.to_string_lossy().to_string();
    }
    
    let ext_with_dot = if ext.starts_with('.') {
        ext
    } else {
        format!(".{}", ext)
    };
    
    format!("{}{}", path.display(), ext_with_dot)
}
