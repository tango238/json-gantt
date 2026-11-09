//! Reading, validating and atomically writing project files.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::document::{self, GanttDocument, normalize_integers};
use crate::error::{AppError, Issue};
use crate::{migrate, schema};

pub type Hash = [u8; 32];

#[derive(Debug, Serialize)]
pub struct OpenResult {
    pub document: Value,
    pub warnings: Vec<Issue>,
}

pub fn hash_bytes(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}

/// Hash of the file's current bytes, or None if it cannot be read.
pub fn hash_file(path: &Path) -> Option<Hash> {
    std::fs::read(path).ok().map(|b| hash_bytes(&b))
}

/// Steps 2-7 of open_file (everything after reading the bytes).
pub fn parse_bytes(bytes: &[u8]) -> Result<OpenResult, AppError> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| AppError::io("not UTF-8", None))?;
    let value: Value = serde_json::from_str(text).map_err(|e| AppError::ParseError {
        message: e.to_string(),
        line: e.line(),
        column: e.column(),
    })?;
    let mut value = value;
    normalize_integers(&mut value); // before migrate, which reads `version`
    let (value, migrated) = migrate::run(value)?;
    let errors = schema::validate(&value);
    if !errors.is_empty() {
        return Err(AppError::SchemaInvalid { errors });
    }
    let doc: GanttDocument = serde_json::from_value(value).map_err(AppError::internal)?;

    let mut warnings = Vec::new();
    if let Some((from, to)) = migrated {
        warnings.push(
            Issue::new(
                "/version",
                "MIGRATED",
                format!("migrated from v{from} to v{to}"),
            )
            .with_param("from", from)
            .with_param("to", to),
        );
    }
    let unknown = doc.unknown_field_paths();
    if !unknown.is_empty() {
        let listed: Vec<&str> = unknown.iter().take(20).map(String::as_str).collect();
        warnings.push(
            Issue::new("/", "UNKNOWN_FIELDS", "unknown fields are preserved")
                .with_param("paths", listed.join(","))
                .with_param("count", unknown.len() as u64),
        );
    }
    let document = serde_json::to_value(&doc).map_err(AppError::internal)?;
    Ok(OpenResult { document, warnings })
}

/// Reads and parses `path`; also returns the SHA-256 of the bytes read.
pub fn read_document(path: &Path) -> Result<(OpenResult, Hash), AppError> {
    let bytes = std::fs::read(path).map_err(|e| AppError::io(e.to_string(), Some(path)))?;
    let hash = hash_bytes(&bytes);
    let result = parse_bytes(&bytes).map_err(|e| match e {
        AppError::Io {
            message,
            path: None,
        } => AppError::io(message, Some(path)),
        e => e,
    })?;
    Ok((result, hash))
}

/// Steps 1-4 of save_file: the canonical bytes to write.
pub fn prepare_save(mut document: Value) -> Result<Vec<u8>, AppError> {
    normalize_integers(&mut document);
    let mut doc: GanttDocument = serde_json::from_value(document).map_err(AppError::internal)?;
    doc.strip_parent_derived();
    let value = serde_json::to_value(&doc).map_err(AppError::internal)?;
    let errors = schema::validate(&value);
    if !errors.is_empty() {
        return Err(AppError::SchemaInvalid { errors });
    }
    Ok(document::to_file_string(&doc)
        .map_err(AppError::internal)?
        .into_bytes())
}

fn temp_path_for(path: &Path, attempt: u32) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(
        ".{name}.{:x}{nanos:x}{n:x}{attempt}.json-gantt.tmp",
        std::process::id()
    ))
}

/// Creates a fresh temp file next to `path` (never reuses an existing one).
fn create_temp(path: &Path) -> std::io::Result<(PathBuf, std::fs::File)> {
    let mut last = None;
    for attempt in 0..8 {
        let tmp = temp_path_for(path, attempt);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.expect("attempted at least once"))
}

/// Writes via a temp file in the same directory, fsync, then rename.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let io_err = |e: std::io::Error| AppError::io(e.to_string(), Some(path));
    let (tmp, mut file) = create_temp(path).map_err(io_err)?;
    let write = |f: &mut std::fs::File| -> std::io::Result<()> {
        f.write_all(bytes)?;
        f.sync_all()
    };
    if let Err(e) = write(&mut file) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(io_err(e));
    }
    drop(file);
    let mut last = None;
    for attempt in 0..3 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                if attempt < 2 && cfg!(windows) {
                    std::thread::sleep(Duration::from_millis(100));
                } else {
                    break;
                }
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(io_err(last.expect("rename failed")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = include_str!("../tests/fixtures/sample.json");

    #[test]
    fn open_sample_ok() {
        let r = parse_bytes(SAMPLE.as_bytes()).unwrap();
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn bom_file_is_readable() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(SAMPLE.as_bytes());
        assert!(parse_bytes(&bytes).is_ok());
    }

    #[test]
    fn broken_json_reports_line_and_column() {
        let err = parse_bytes(b"{\n  \"version\": 1,\n  oops\n}").unwrap_err();
        match err {
            AppError::ParseError { line, column, .. } => {
                assert_eq!(line, 3);
                assert_eq!(column, 3);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            serde_json::to_value(parse_bytes(b"{").unwrap_err()).unwrap()["kind"],
            "PARSE_ERROR"
        );
    }

    #[test]
    fn version_2_is_unsupported() {
        let mut v: Value = serde_json::from_str(SAMPLE).unwrap();
        v["version"] = json!(2);
        match parse_bytes(v.to_string().as_bytes()) {
            Err(AppError::UnsupportedVersion {
                found: 2,
                supported: 1,
            }) => {}
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn non_utf8_is_io_error() {
        match parse_bytes(&[0xFF, 0xFE, 0x00]) {
            Err(AppError::Io { message, .. }) => assert_eq!(message, "not UTF-8"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn schema_violation_lists_errors() {
        let mut v: Value = serde_json::from_str(SAMPLE).unwrap();
        v.as_object_mut().unwrap().remove("tasks");
        match parse_bytes(v.to_string().as_bytes()) {
            Err(AppError::SchemaInvalid { errors }) => assert_eq!(errors[0].code, "required"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn unknown_fields_warning() {
        let r = parse_bytes(include_bytes!("../tests/fixtures/unknown_fields.json")).unwrap();
        assert_eq!(r.warnings.len(), 1);
        assert_eq!(r.warnings[0].code, "UNKNOWN_FIELDS");
        assert!(
            r.warnings[0].params["paths"]
                .as_str()
                .unwrap()
                .contains("/topX")
        );
    }

    #[test]
    fn atomic_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, "old").unwrap();
        let bytes = prepare_save(serde_json::from_str(SAMPLE).unwrap()).unwrap();
        atomic_write(&path, &bytes).unwrap();
        let written = std::fs::read(&path).unwrap();
        assert_eq!(written, SAMPLE.as_bytes());
        assert_eq!(*written.last().unwrap(), b'\n');
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn integral_floats_are_accepted() {
        let v: Value = serde_json::from_str(SAMPLE).unwrap();
        let idx = v["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .position(|t| t.get("progress").is_some())
            .unwrap();
        let text = v
            .to_string()
            .replacen("\"version\":1", "\"version\":1.0", 1);
        assert!(text.contains("\"version\":1.0"));
        let mut raw: Value = serde_json::from_str(&text).unwrap();
        raw["tasks"][idx]["progress"] = serde_json::from_str("50.0").unwrap();
        let text = serde_json::to_string(&raw).unwrap();
        assert!(text.contains("50.0"));
        let r = parse_bytes(text.as_bytes()).unwrap();
        assert_eq!(r.document["version"], json!(1));
        assert_eq!(r.document["tasks"][idx]["progress"], json!(50));
        // and via save
        assert!(prepare_save(raw).is_ok());
    }

    #[test]
    fn temp_files_are_unique_and_not_reused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (t1, _f1) = create_temp(&p).unwrap();
        let (t2, _f2) = create_temp(&p).unwrap();
        assert_ne!(t1, t2);
    }

    #[test]
    fn full_pipeline_is_byte_identical() {
        for src in [
            SAMPLE,
            include_str!("../tests/fixtures/unknown_fields.json"),
        ] {
            let r = parse_bytes(src.as_bytes()).unwrap();
            let out = prepare_save(r.document).unwrap();
            assert_eq!(String::from_utf8(out).unwrap(), src);
        }
    }

    #[test]
    fn prepare_save_strips_parent_derived_values() {
        let mut v: Value = serde_json::from_str(SAMPLE).unwrap();
        let tasks = v["tasks"].as_array().unwrap().clone();
        let parent_idx = tasks
            .iter()
            .position(|t| tasks.iter().any(|c| c["parentId"] == t["id"]))
            .unwrap();
        v["tasks"][parent_idx]["start"] = json!("2023-01-01");
        v["tasks"][parent_idx]["end"] = json!("2023-01-02");
        v["tasks"][parent_idx]["progress"] = json!(10);
        v["tasks"][parent_idx]["hours"] = json!(5);
        let out: Value = serde_json::from_slice(&prepare_save(v).unwrap()).unwrap();
        for k in ["start", "end", "progress", "hours"] {
            assert!(out["tasks"][parent_idx].get(k).is_none(), "{k}");
        }
    }

    #[test]
    fn save_rejects_schema_violation() {
        let mut v: Value = serde_json::from_str(SAMPLE).unwrap();
        let idx = v["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .position(|t| t.get("start").is_some())
            .unwrap();
        v["tasks"][idx]["start"] = json!("bad");
        assert!(matches!(
            prepare_save(v),
            Err(AppError::SchemaInvalid { .. })
        ));
    }
}
