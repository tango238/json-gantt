//! External change detection. The parent directory is watched so that
//! "write temp file then rename" saves by other editors are noticed.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, new_debouncer};

use crate::fileio;
use crate::state::WatchShared;

pub type Debouncer = notify_debouncer_mini::Debouncer<RecommendedWatcher>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Modified,
    Removed,
}

impl ChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Modified => "modified",
            ChangeKind::Removed => "removed",
        }
    }
}

/// Parent directory canonicalized + file name, so comparisons survive
/// symlinked temp dirs (/var vs /private/var) and deleted files.
pub fn normalize(path: &Path) -> PathBuf {
    if let Ok(p) = path.canonicalize() {
        return p;
    }
    match (
        path.parent().and_then(|p| p.canonicalize().ok()),
        path.file_name(),
    ) {
        (Some(dir), Some(name)) => dir.join(name),
        _ => path.to_path_buf(),
    }
}

/// Decides whether the current state of `path` differs from what we know.
pub fn detect_change(path: &Path, shared: &WatchShared) -> Option<ChangeKind> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let hash = fileio::hash_bytes(&bytes);
            let mut known = shared.known_hash.lock().unwrap();
            *shared.removed.lock().unwrap() = false;
            if *known == Some(hash) {
                return None;
            }
            *known = Some(hash);
            // Our own recent write (possibly superseded by a later one).
            if shared.is_recent_own(&hash) {
                return None;
            }
            Some(ChangeKind::Modified)
        }
        Err(_) if !path.exists() => {
            let mut removed = shared.removed.lock().unwrap();
            if *removed {
                None
            } else {
                *removed = true;
                Some(ChangeKind::Removed)
            }
        }
        Err(_) => None,
    }
}

/// Starts watching `path`. `handler` is called on the watcher thread.
pub fn start(
    path: &Path,
    shared: Arc<WatchShared>,
    handler: impl Fn(ChangeKind) + Send + 'static,
) -> Result<Debouncer, notify::Error> {
    let target = normalize(path);
    let target_for_read = path.to_path_buf();
    let dir = target
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            if !events.iter().any(|e| normalize(&e.path) == target) {
                return;
            }
            if let Some(kind) = detect_change(&target_for_read, &shared) {
                handler(kind);
            }
        },
    )?;
    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)?;
    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn setup(content: &str) -> (tempfile::TempDir, PathBuf, Arc<WatchShared>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        std::fs::write(&path, content).unwrap();
        let shared = Arc::new(WatchShared::default());
        *shared.known_hash.lock().unwrap() = fileio::hash_file(&path);
        (dir, path, shared)
    }

    #[test]
    fn external_write_fires_modified_once() {
        let (_dir, path, shared) = setup("one");
        let (tx, rx) = mpsc::channel();
        let _w = start(&path, shared, move |k| tx.send(k).unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(&path, "two").unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            ChangeKind::Modified
        );
        assert!(
            rx.recv_timeout(Duration::from_millis(700)).is_err(),
            "must fire once"
        );
    }

    #[test]
    fn own_save_is_not_reported() {
        let (_dir, path, shared) = setup("one");
        let (tx, rx) = mpsc::channel();
        let _w = start(&path, shared.clone(), move |k| tx.send(k).unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        // Same order as save_file: hash first, then write.
        shared.record_own(fileio::hash_bytes(b"mine"));
        std::fs::write(&path, "mine").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1000)).is_err());
    }

    #[test]
    fn removal_is_reported_once() {
        let (_dir, path, shared) = setup("one");
        let (tx, rx) = mpsc::channel();
        let _w = start(&path, shared, move |k| tx.send(k).unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            ChangeKind::Removed
        );
    }
}
