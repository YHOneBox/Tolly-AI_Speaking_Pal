//! Files that belong to this copy of Tolly live next to the executable.

use std::path::PathBuf;

use crate::error::ApiError;

pub fn data_dir() -> Result<PathBuf, ApiError> {
    let exe = std::env::current_exe().map_err(|err| ApiError::storage(err.to_string()))?;
    let folder = exe.parent().ok_or_else(|| {
        ApiError::storage("The folder that contains Tolly could not be found.")
    })?;
    let directory = folder.join("data");
    std::fs::create_dir_all(&directory).map_err(|err| ApiError::storage(err.to_string()))?;
    Ok(directory)
}
