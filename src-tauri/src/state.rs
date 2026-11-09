use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::AppError;
use crate::fileio::{self, Hash};
use crate::watcher::{Debouncer, normalize};

/// How long a hash we wrote ourselves is remembered (covers back-to-back saves).
const OWN_WRITE_TTL: Duration = Duration::from_secs(5);

/// State shared between a window's entry and its watcher thread.
#[derive(Default)]
pub struct WatchShared {
    pub known_hash: Mutex<Option<Hash>>,
    pub removed: Mutex<bool>,
    own_writes: Mutex<Vec<(Hash, Instant)>>,
}

impl WatchShared {
    /// Registers a hash we are about to write ourselves.
    pub fn record_own(&self, hash: Hash) {
        let mut own = self.own_writes.lock().unwrap();
        own.retain(|(_, t)| t.elapsed() < OWN_WRITE_TTL);
        own.push((hash, Instant::now()));
        *self.known_hash.lock().unwrap() = Some(hash);
    }

    /// Undoes `record_own` after a failed write.
    pub fn revert_own(&self, hash: Hash, previous: Option<Hash>) {
        self.own_writes.lock().unwrap().retain(|(h, _)| *h != hash);
        *self.known_hash.lock().unwrap() = previous;
    }

    pub fn is_recent_own(&self, hash: &Hash) -> bool {
        self.own_writes
            .lock()
            .unwrap()
            .iter()
            .any(|(h, t)| h == hash && t.elapsed() < OWN_WRITE_TTL)
    }
}

pub struct WindowFile {
    /// Normalized (see `watcher::normalize`).
    pub path: PathBuf,
    pub shared: Arc<WatchShared>,
    /// Held only to keep the watcher alive; dropping it stops watching.
    #[allow(dead_code)]
    pub debouncer: Option<Debouncer>,
}

/// Where an OS open request goes.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Emit,
    Queued,
}

/// Ready windows and queued paths live under one lock so that a request
/// cannot slip between "check ready" and "queue".
#[derive(Default)]
pub struct Routing {
    pub ready: HashSet<String>,
    pub pending: HashMap<String, Vec<PathBuf>>,
}

impl Routing {
    pub fn route(&mut self, label: &str, path: PathBuf) -> Route {
        if self.ready.contains(label) {
            Route::Emit
        } else {
            self.pending
                .entry(label.to_string())
                .or_default()
                .push(path);
            Route::Queued
        }
    }

    /// Marks `label` ready and returns (first queued path, the rest).
    pub fn take(&mut self, label: &str) -> (Option<PathBuf>, Vec<PathBuf>) {
        self.ready.insert(label.to_string());
        let mut queued = self.pending.remove(label).unwrap_or_default();
        if queued.is_empty() {
            return (None, queued);
        }
        let first = queued.remove(0);
        (Some(first), queued)
    }
}

/// A run in progress (at most one per session).
pub struct RunHandle {
    pub run_id: String,
    /// `true` asks the process to stop.
    pub cancel: tokio::sync::watch::Sender<bool>,
    /// Process group id (= pid of the child, which leads its own group); 0
    /// until spawned and again after it exited. Written by `ai::run_process`.
    pub pgid: Arc<AtomicU32>,
}

/// One AI conversation of a window. Dropping it deletes the temp directory.
pub struct AiSession {
    pub dir: tempfile::TempDir,
    pub run: Option<RunHandle>,
    /// A stop request for this run id that arrived before the run was registered.
    pub pending_stop: Option<String>,
}

impl AiSession {
    pub fn new(dir: tempfile::TempDir) -> Self {
        AiSession {
            dir,
            run: None,
            pending_stop: None,
        }
    }

    /// Asks a running process to stop.
    pub fn cancel(&self) {
        if let Some(r) = &self.run {
            let _ = r.cancel.send(true);
        }
    }

    /// Registers a run. Errors when one is already registered. A stop request
    /// that arrived earlier for the same id makes the run start cancelled.
    pub fn register_run(
        &mut self,
        run_id: &str,
    ) -> Result<(tokio::sync::watch::Receiver<bool>, Arc<AtomicU32>), AppError> {
        if self.run.is_some() {
            return Err(AppError::Ai {
                message: "a run is already in progress".into(),
            });
        }
        let pre_cancelled = self.pending_stop.take().as_deref() == Some(run_id);
        let (tx, rx) = tokio::sync::watch::channel(pre_cancelled);
        let pgid = Arc::new(AtomicU32::new(0));
        self.run = Some(RunHandle {
            run_id: run_id.to_string(),
            cancel: tx,
            pgid: pgid.clone(),
        });
        Ok((rx, pgid))
    }

    /// Stop request from the UI. `run_id` `None` stops whatever runs; `Some`
    /// stops that run, or (when it is not registered yet) is remembered so
    /// that the run is cancelled the moment it registers.
    pub fn request_stop(&mut self, run_id: Option<&str>) {
        match (&self.run, run_id) {
            (Some(r), Some(id)) if r.run_id != id => {}
            (Some(_), _) => self.cancel(),
            (None, Some(id)) => self.pending_stop = Some(id.to_string()),
            (None, None) => {}
        }
    }

    fn group(&self) -> Option<u32> {
        let r = self.run.as_ref()?;
        match r.pgid.load(Ordering::SeqCst) {
            0 => None,
            n => Some(n),
        }
    }
}

#[derive(Default)]
pub struct AppState {
    pub ai: Mutex<HashMap<String, AiSession>>,
    pub windows: Mutex<HashMap<String, WindowFile>>,
    pub routing: Mutex<Routing>,
    pub window_counter: AtomicU32,
}

impl AppState {
    /// Records the on-disk hash of `path` for `label`. A different path drops
    /// the old watcher; the same path keeps it.
    pub fn set_file(&self, label: &str, path: &Path, hash: Hash) {
        let key = normalize(path);
        let mut windows = self.windows.lock().unwrap();
        match windows.get_mut(label) {
            Some(w) if w.path == key => {
                *w.shared.known_hash.lock().unwrap() = Some(hash);
                *w.shared.removed.lock().unwrap() = false;
            }
            _ => {
                let shared = Arc::new(WatchShared::default());
                *shared.known_hash.lock().unwrap() = Some(hash);
                windows.insert(
                    label.to_string(),
                    WindowFile {
                        path: key,
                        shared,
                        debouncer: None,
                    },
                );
            }
        }
    }

    /// Writes `bytes` to `path` atomically. If the window already watches
    /// `path`, our hash is registered before the write (so the watcher ignores
    /// it) and rolled back on failure. For a different path the window's entry
    /// is only replaced after the write succeeded.
    pub fn save(&self, label: &str, path: &Path, bytes: &[u8]) -> Result<(), AppError> {
        let key = normalize(path);
        let hash = fileio::hash_bytes(bytes);
        let prior = {
            let windows = self.windows.lock().unwrap();
            windows.get(label).filter(|w| w.path == key).map(|w| {
                let previous = *w.shared.known_hash.lock().unwrap();
                w.shared.record_own(hash);
                (w.shared.clone(), previous)
            })
        };
        let result = fileio::atomic_write(path, bytes);
        match (&result, prior) {
            (Ok(()), None) => self.set_file(label, path, hash),
            (Err(_), Some((shared, previous))) => shared.revert_own(hash, previous),
            _ => {}
        }
        result
    }

    /// True when `label` already has a live watcher on `path`.
    pub fn is_watching(&self, label: &str, path: &Path) -> bool {
        let key = normalize(path);
        self.windows
            .lock()
            .unwrap()
            .get(label)
            .is_some_and(|w| w.path == key && w.debouncer.is_some())
    }

    /// Stops the window's AI run (if any) and deletes its temp directory.
    /// Synchronous: the process group is gone (SIGKILL after 1 s) on return.
    pub fn remove_ai(&self, label: &str) {
        let session = self.ai.lock().unwrap().remove(label);
        if let Some(s) = session {
            Self::stop_sessions(vec![s]);
        }
    }

    /// App exit: stop every run and delete every temp directory. Synchronous
    /// (the process exits right after, so nothing async would get to run).
    pub fn remove_all_ai(&self) {
        let all: Vec<AiSession> = self.ai.lock().unwrap().drain().map(|(_, s)| s).collect();
        Self::stop_sessions(all);
    }

    fn stop_sessions(sessions: Vec<AiSession>) {
        let mut groups = Vec::new();
        for s in &sessions {
            s.cancel();
            groups.extend(s.group());
        }
        crate::ai::kill_groups_blocking(&groups, crate::ai::EXIT_KILL_GRACE);
        // `sessions` drop here and delete the temp directories.
    }

    pub fn remove_window(&self, label: &str) {
        self.windows.lock().unwrap().remove(label);
        self.remove_ai(label);
        let mut r = self.routing.lock().unwrap();
        r.pending.remove(label);
        r.ready.remove(label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::{self, ChangeKind};
    use std::sync::mpsc;

    fn watched(state: &AppState, label: &str, path: &Path) -> mpsc::Receiver<ChangeKind> {
        let shared = Arc::new(WatchShared::default());
        *shared.known_hash.lock().unwrap() = fileio::hash_file(path);
        let (tx, rx) = mpsc::channel();
        let d = watcher::start(path, shared.clone(), move |k| tx.send(k).unwrap()).unwrap();
        state.windows.lock().unwrap().insert(
            label.to_string(),
            WindowFile {
                path: normalize(path),
                shared,
                debouncer: Some(d),
            },
        );
        rx
    }

    #[test]
    fn own_save_is_not_reported_via_real_save_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.json");
        std::fs::write(&path, "one").unwrap();
        let state = AppState::default();
        let rx = watched(&state, "main", &path);
        std::thread::sleep(Duration::from_millis(200));
        // Two back-to-back saves inside one debounce window.
        state.save("main", &path, b"two").unwrap();
        state.save("main", &path, b"three").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1200)).is_err());
        // A genuinely external edit is still reported.
        std::fs::write(&path, "external").unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            ChangeKind::Modified
        );
    }

    #[test]
    fn is_watching_requires_same_path_and_live_debouncer() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.json");
        let b = dir.path().join("b.json");
        std::fs::write(&a, "1").unwrap();
        std::fs::write(&b, "2").unwrap();
        let state = AppState::default();
        assert!(!state.is_watching("main", &a));
        // Hash recorded by open_file only: no debouncer yet.
        state.set_file("main", &a, fileio::hash_bytes(b"1"));
        assert!(!state.is_watching("main", &a));
        let _rx = watched(&state, "main", &a);
        assert!(state.is_watching("main", &a));
        assert!(!state.is_watching("main", &b));
        assert!(!state.is_watching("doc-1", &a));
    }

    #[test]
    fn failed_save_as_keeps_original_watch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.json");
        std::fs::write(&path, "one").unwrap();
        let state = AppState::default();
        let rx = watched(&state, "main", &path);
        let before = fileio::hash_file(&path);
        let bad = dir.path().join("no-such-dir").join("x.json");
        assert!(state.save("main", &bad, b"data").is_err());
        {
            let w = state.windows.lock().unwrap();
            let e = &w["main"];
            assert_eq!(e.path, normalize(&path));
            assert!(e.debouncer.is_some());
            assert_eq!(*e.shared.known_hash.lock().unwrap(), before);
        }
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(&path, "changed").unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            ChangeKind::Modified
        );
    }

    #[test]
    fn failed_save_same_path_restores_hash() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let path = sub.join("d.json");
        std::fs::write(&path, "one").unwrap();
        let state = AppState::default();
        let _rx = watched(&state, "main", &path);
        let before = fileio::hash_file(&path);
        // Make the target a directory so the rename fails.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(state.save("main", &path, b"data").is_err());
        let w = state.windows.lock().unwrap();
        assert_eq!(*w["main"].shared.known_hash.lock().unwrap(), before);
        assert!(!w["main"].shared.is_recent_own(&fileio::hash_bytes(b"data")));
    }

    #[test]
    fn save_as_new_path_switches_entry() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.json");
        let b = dir.path().join("b.json");
        std::fs::write(&a, "a").unwrap();
        let state = AppState::default();
        let _rx = watched(&state, "main", &a);
        state.save("main", &b, b"b").unwrap();
        let w = state.windows.lock().unwrap();
        assert_eq!(w["main"].path, normalize(&b));
        assert!(w["main"].debouncer.is_none());
    }

    fn session() -> AiSession {
        AiSession::new(tempfile::tempdir().unwrap())
    }

    #[test]
    fn register_run_is_exclusive_and_stop_cancels() {
        let mut s = session();
        let (rx, _pgid) = s.register_run("a").unwrap();
        assert!(matches!(s.register_run("b"), Err(AppError::Ai { .. })));
        assert!(!*rx.borrow());
        s.request_stop(Some("other")); // not this run: ignored
        assert!(!*rx.borrow());
        s.request_stop(Some("a"));
        assert!(*rx.borrow());
    }

    #[test]
    fn stop_before_register_cancels_that_run_only() {
        let mut s = session();
        s.request_stop(Some("a")); // nothing registered yet
        let (rx, _) = s.register_run("a").unwrap();
        assert!(*rx.borrow(), "run starts cancelled");
        s.run = None;
        // a pending stop is consumed, and is only for its own id
        let (rx, _) = s.register_run("a").unwrap();
        assert!(!*rx.borrow());
        s.run = None;
        s.request_stop(Some("x"));
        let (rx, _) = s.register_run("y").unwrap();
        assert!(!*rx.borrow());
        s.run = None;
        s.request_stop(None); // no run, no id: nothing to remember
        let (rx, _) = s.register_run("z").unwrap();
        assert!(!*rx.borrow());
    }

    #[test]
    fn remove_ai_sends_cancel_and_drops_session() {
        let state = AppState::default();
        let mut s = session();
        let dir = s.dir.path().to_path_buf();
        let (rx, _) = s.register_run("a").unwrap();
        state.ai.lock().unwrap().insert("w".into(), s);
        state.remove_ai("w");
        assert!(*rx.borrow());
        assert!(state.ai.lock().unwrap().is_empty());
        assert!(!dir.exists());
    }

    #[test]
    fn routing_queues_until_ready_then_emits() {
        let mut r = Routing::default();
        assert_eq!(r.route("main", "/a.json".into()), Route::Queued);
        assert_eq!(r.route("main", "/b.json".into()), Route::Queued);
        assert_eq!(r.route("main", "/c.json".into()), Route::Queued);
        let (first, rest) = r.take("main");
        assert_eq!(first, Some(PathBuf::from("/a.json")));
        assert_eq!(rest, [PathBuf::from("/b.json"), PathBuf::from("/c.json")]);
        assert_eq!(r.route("main", "/d.json".into()), Route::Emit);
        assert_eq!(r.take("main"), (None, vec![]));
    }
}
