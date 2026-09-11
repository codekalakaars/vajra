use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};

use super::{copy_file, list_files, read_file, write_file, FileEntry};

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
