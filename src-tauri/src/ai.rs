//! Running the `claude` CLI for the AI pane (design: docs/design/06-ai-pane.md §5).
//!
//! Everything here is independent of Tauri so that it can be unit-tested with
//! fake scripts. `commands/ai.rs` only adds event emission and state handling.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::error::{AppError, Issue};
use crate::fileio::{self, Hash};

/// Whole-turn limit.
pub const AI_TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Limit for silence on stdout.
pub const AI_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Time between SIGTERM and SIGKILL.
pub const KILL_GRACE: Duration = Duration::from_secs(3);
/// Time between SIGTERM and SIGKILL when the app exits or a window closes
/// (synchronous, so it must be short).
pub const EXIT_KILL_GRACE: Duration = Duration::from_secs(1);
/// After the process exited, how long we keep waiting for its pipes to close.
/// Leftover grandchildren are killed first, so this is only a safety net.
const PIPE_DRAIN_GRACE: Duration = Duration::from_secs(2);
/// Lines longer than this are dropped.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 16 * 1024;
pub const TEMP_PREFIX: &str = "json-gantt-ai-";
pub const SCHEMA_JSON: &str = include_str!("../../schema/gantt.schema.json");

// ---------------------------------------------------------------- resolve

#[cfg(windows)]
const CLAUDE_EXE: &str = "claude.exe";
#[cfg(not(windows))]
const CLAUDE_EXE: &str = "claude";

/// True for a regular file that can be executed (unix: has an execute bit).
pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Candidate order of 06§5.3. Duplicates are removed (first one wins).
pub fn candidates(
    setting: Option<&Path>,
    home: Option<&Path>,
    path_env: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = Vec::new();
    if let Some(s) = setting {
        list.push(s.to_path_buf());
    }
    if let Some(h) = home {
        list.push(h.join(".local").join("bin").join(CLAUDE_EXE));
        list.push(h.join(".claude").join("local").join(CLAUDE_EXE));
    }
    list.push(PathBuf::from("/opt/homebrew/bin").join(CLAUDE_EXE));
    list.push(PathBuf::from("/usr/local/bin").join(CLAUDE_EXE));
    if let Some(p) = path_env {
        for dir in std::env::split_paths(p) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            list.push(dir.join(CLAUDE_EXE));
        }
    }
    let mut seen = std::collections::HashSet::new();
    list.retain(|p| seen.insert(p.clone()));
    list
}

/// The first executable candidate, or the list of everything that was tried.
pub fn resolve_claude(
    setting: Option<&Path>,
    home: Option<&Path>,
    path_env: Option<&OsStr>,
    is_exec: impl Fn(&Path) -> bool,
) -> Result<PathBuf, Vec<PathBuf>> {
    let list = candidates(setting, home, path_env);
    match list.iter().find(|p| is_exec(p)) {
        Some(p) => Ok(p.clone()),
        None => Err(list),
    }
}

// ------------------------------------------------------------------- args

/// `8-4-4-4-12` hex digits.
fn valid_session_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Fixed argument list of 06§5.4. The last two elements are always
/// `--setting-sources ""` followed by the prompt.
pub fn build_args(
    append_system_prompt: &str,
    resume: Option<&str>,
    prompt: &str,
) -> Result<Vec<OsString>, AppError> {
    if let Some(id) = resume
        && !valid_session_id(id)
    {
        return Err(AppError::Ai {
            message: "invalid session id".into(),
        });
    }
    if prompt.starts_with('-') {
        // Would be read as an option (the prompt is the last positional argument).
        return Err(AppError::Ai {
            message: "prompt must not start with '-'".into(),
        });
    }
    let mut a: Vec<OsString> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "Read,Edit",
        "--allowedTools",
        "Read,Edit",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--permission-mode",
        "acceptEdits",
        "--permission-prompts",
        "none",
        "--restricted",
        "--append-system-prompt",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    a.push(append_system_prompt.into());
    if let Some(id) = resume {
        a.push("--resume".into());
        a.push(id.into());
    }
    a.push("--setting-sources".into());
    a.push("".into());
    a.push(prompt.into());
    Ok(a)
}

// -------------------------------------------------------------------- env

/// `PATH` for the child: the executable's directory and the usual install
/// directories first, then the current value.
pub fn scrubbed_path(exe: &Path, current: Option<&OsStr>) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = exe.parent().filter(|d| !d.as_os_str().is_empty()) {
        dirs.push(d.to_path_buf());
    }
    #[cfg(unix)]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    if let Some(c) = current {
        dirs.extend(std::env::split_paths(c));
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| current.unwrap_or_default().to_os_string())
}

/// Removes `CLAUDECODE` and prepends to `PATH`. Everything else is inherited.
pub fn scrub_env(cmd: &mut Command, exe: &Path) {
    cmd.env_remove("CLAUDECODE");
    let current = std::env::var_os("PATH");
    cmd.env("PATH", scrubbed_path(exe, current.as_deref()));
}

// ----------------------------------------------------------- line splitter

/// Splits a byte stream into lines (`\n`, trailing `\r` removed).
#[derive(Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
    discarding: bool,
    /// Number of lines dropped for exceeding `MAX_LINE_BYTES`.
    pub dropped: usize,
}

impl LineSplitter {
    fn take_line(&mut self) -> Option<String> {
        if std::mem::take(&mut self.discarding) {
            self.buf.clear();
            self.dropped += 1;
            return None;
        }
        if self.buf.last() == Some(&b'\r') {
            self.buf.pop();
        }
        let s = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        Some(s)
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for part in chunk.split_inclusive(|b| *b == b'\n') {
            let (body, complete) = match part.split_last() {
                Some((b'\n', rest)) => (rest, true),
                _ => (part, false),
            };
            if !self.discarding {
                if self.buf.len() + body.len() > MAX_LINE_BYTES {
                    self.discarding = true;
                    self.buf.clear();
                } else {
                    self.buf.extend_from_slice(body);
                }
            }
            if complete && let Some(line) = self.take_line() {
                out.push(line);
            }
        }
        out
    }

    /// The last fragment without a newline, if any.
    pub fn finish(&mut self) -> Option<String> {
        if self.discarding {
            return self.take_line();
        }
        if self.buf.is_empty() {
            return None;
        }
        self.take_line()
    }
}

// ----------------------------------------------------------------- results

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiExit {
    pub code: Option<i32>,
    pub stopped: bool,
    pub timed_out: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AiFileResult {
    Unchanged,
    Missing,
    Changed {
        document: Value,
        warnings: Vec<Issue>,
    },
    Invalid {
        error: AppError,
    },
}

#[derive(Debug)]
pub struct Outcome {
    pub exit: AiExit,
    pub stderr_tail: String,
    pub last_result_line: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub turn: Duration,
    pub idle: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            turn: AI_TURN_TIMEOUT,
            idle: AI_IDLE_TIMEOUT,
        }
    }
}

/// Writes `schema.json` and the canonical `gantt.json`; returns the hash of
/// the latter.
pub fn write_session_files(dir: &Path, document: Value) -> Result<Hash, AppError> {
    let bytes = fileio::prepare_save(document)?;
    let gantt = dir.join("gantt.json");
    std::fs::write(&gantt, &bytes).map_err(|e| AppError::io(e.to_string(), Some(&gantt)))?;
    write_schema(dir)?;
    Ok(fileio::hash_bytes(&bytes))
}

pub fn write_schema(dir: &Path) -> Result<(), AppError> {
    let p = dir.join("schema.json");
    std::fs::write(&p, SCHEMA_JSON).map_err(|e| AppError::io(e.to_string(), Some(&p)))
}

/// Reads `gantt.json` back after a run.
pub fn read_back(dir: &Path, written: &Hash) -> AiFileResult {
    let path = dir.join("gantt.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return AiFileResult::Missing;
    };
    if fileio::hash_bytes(&bytes) == *written {
        return AiFileResult::Unchanged;
    }
    match fileio::parse_bytes(&bytes) {
        Ok(r) => AiFileResult::Changed {
            document: r.document,
            warnings: r.warnings,
        },
        Err(error) => AiFileResult::Invalid { error },
    }
}

/// Deletes `json-gantt-ai-*` directories under `base` that were modified at
/// least `older_than` ago. Returns how many were removed. Failures are ignored.
pub fn cleanup_stale(base: &Path, older_than: Duration) -> usize {
    let Ok(rd) = std::fs::read_dir(base) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.flatten() {
        if !e.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let age = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .unwrap_or_default();
        if age >= older_than && std::fs::remove_dir_all(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

// ------------------------------------------------------------------ process

#[cfg(unix)]
fn signal_group(pgid: u32, sig: i32) -> bool {
    // SAFETY: plain syscall; the group was created by us via process_group(0).
    unsafe { libc::killpg(pgid as i32, sig) == 0 }
}

/// Synchronously stops process groups: SIGTERM to all, wait up to `grace`
/// for them to vanish (reaping group leaders that are our children), then
/// SIGKILL whatever is left. Does nothing on non-unix targets (the async
/// `kill_on_drop` / cancel path is all there is there).
pub fn kill_groups_blocking(pgids: &[u32], grace: Duration) {
    #[cfg(unix)]
    {
        if pgids.is_empty() {
            return;
        }
        for g in pgids {
            signal_group(*g, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + grace;
        let mut alive: Vec<u32> = pgids.to_vec();
        while !alive.is_empty() && std::time::Instant::now() < deadline {
            alive.retain(|g| {
                // Reap the leader if it is our zombie child; then probe the group.
                let mut st = 0;
                // SAFETY: plain syscall.
                unsafe { libc::waitpid(*g as i32, &mut st, libc::WNOHANG) };
                signal_group(*g, 0)
            });
            if !alive.is_empty() {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        for g in pgids {
            signal_group(*g, libc::SIGKILL);
        }
        for g in pgids {
            // SAFETY: plain syscall.
            unsafe { libc::waitpid(*g as i32, std::ptr::null_mut(), libc::WNOHANG) };
        }
    }
    #[cfg(not(unix))]
    let _ = (pgids, grace);
}

/// Stops the child (and its process group on unix): SIGTERM, then SIGKILL
/// after `KILL_GRACE`. The group always gets a final SIGKILL, so that
/// grandchildren do not survive a parent that exits on SIGTERM.
async fn terminate(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            signal_group(pid, libc::SIGTERM);
            let _ = tokio::time::timeout(KILL_GRACE, child.wait()).await;
            signal_group(pid, libc::SIGKILL);
            let _ = child.wait().await;
            return;
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn push_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    tail.extend_from_slice(chunk);
    if tail.len() > STDERR_TAIL_BYTES {
        let cut = tail.len() - STDERR_TAIL_BYTES;
        tail.drain(..cut);
    }
}

/// Optional knobs of `run_process`.
#[derive(Default)]
pub struct RunOpts {
    pub timeouts: Timeouts,
    /// Receives the child's pid (= process group id) after spawn and 0 once
    /// the run is over, so that another thread can kill the group.
    pub pgid_out: Option<Arc<AtomicU32>>,
    /// Extra environment for the child (applied before `scrub_env`).
    pub extra_env: Vec<(OsString, OsString)>,
}

/// Runs `exe args` in `cwd`, calling `on_line` for every stdout line.
///
/// `cancel` turning true (or its sender being dropped) stops the process; if
/// it is already true nothing is spawned.
pub async fn run_process<F>(
    exe: &Path,
    args: &[OsString],
    cwd: &Path,
    mut cancel: watch::Receiver<bool>,
    opts: RunOpts,
    mut on_line: F,
) -> Result<Outcome, AppError>
where
    F: FnMut(&str) + Send,
{
    let RunOpts {
        timeouts,
        pgid_out,
        extra_env,
    } = opts;
    if *cancel.borrow() {
        return Ok(Outcome {
            exit: AiExit {
                code: None,
                stopped: true,
                timed_out: false,
            },
            stderr_tail: String::new(),
            last_result_line: None,
        });
    }
    let mut cmd = Command::new(exe);
    cmd.envs(extra_env);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    scrub_env(&mut cmd, exe);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| AppError::Ai {
        message: format!("spawn: {e}"),
    })?;
    let pid = child.id();
    if let (Some(slot), Some(pid)) = (&pgid_out, pid) {
        slot.store(pid, Ordering::SeqCst);
    }
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");

    let err_task = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            push_tail(&mut tail, &buf[..n]);
        }
        tail
    });

    let started = Instant::now();
    let mut last_activity = started;
    let mut splitter = LineSplitter::default();
    let mut last_result: Option<String> = None;
    let mut handle_line = |line: String, on_line: &mut F| {
        if line.is_empty() {
            return;
        }
        if line.contains("\"result\"")
            && let Ok(v) = serde_json::from_str::<Value>(&line)
            && v.get("type").and_then(Value::as_str) == Some("result")
        {
            last_result = Some(line.clone());
        }
        on_line(&line);
    };

    let mut status: Option<std::process::ExitStatus> = None;
    let mut drain_deadline: Option<Instant> = None;
    let mut stdout_open = true;
    let (mut stopped, mut timed_out) = (false, false);
    let mut buf = vec![0u8; 16 * 1024];

    // Cancel requested between the check above and the spawn.
    if *cancel.borrow() {
        stopped = true;
        terminate(&mut child, pid).await;
        status = child.try_wait().ok().flatten();
        stdout_open = false;
    }

    loop {
        if stopped || timed_out || (status.is_some() && !stdout_open) {
            break;
        }
        let turn_at = started + timeouts.turn;
        let idle_at = last_activity + timeouts.idle;
        let drain_at = drain_deadline.unwrap_or(turn_at);
        tokio::select! {
            r = stdout.read(&mut buf), if stdout_open => {
                match r {
                    Ok(0) | Err(_) => stdout_open = false,
                    Ok(n) => {
                        last_activity = Instant::now();
                        for l in splitter.push(&buf[..n]) {
                            handle_line(l, &mut on_line);
                        }
                    }
                }
            }
            s = child.wait(), if status.is_none() => {
                status = s.ok();
                // Whatever the process left behind must not keep running (or
                // hold the pipes open).
                #[cfg(unix)]
                if let Some(pid) = pid {
                    signal_group(pid, libc::SIGKILL);
                }
                drain_deadline = Some(Instant::now() + PIPE_DRAIN_GRACE);
                if status.is_none() { break; }
            }
            ch = cancel.changed() => {
                // A dropped sender counts as a stop request.
                let _ = ch;
                if status.is_none() {
                    stopped = true;
                    terminate(&mut child, pid).await;
                    status = child.try_wait().ok().flatten();
                } else if *cancel.borrow() || ch.is_err() {
                    // Already exited: only the pipes remain, stop waiting.
                    break;
                }
            }
            _ = tokio::time::sleep_until(turn_at), if status.is_none() => {
                timed_out = true;
                terminate(&mut child, pid).await;
                status = child.try_wait().ok().flatten();
            }
            _ = tokio::time::sleep_until(idle_at), if status.is_none() => {
                timed_out = true;
                terminate(&mut child, pid).await;
                status = child.try_wait().ok().flatten();
            }
            _ = tokio::time::sleep_until(drain_at), if drain_deadline.is_some() => break,
        }
    }

    // Flush what the pipes still hold after a stop (bounded).
    if stdout_open {
        let flush = async {
            while let Ok(n) = stdout.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                for l in splitter.push(&buf[..n]) {
                    handle_line(l, &mut on_line);
                }
            }
        };
        let _ = tokio::time::timeout(PIPE_DRAIN_GRACE, flush).await;
    }
    if let Some(l) = splitter.finish() {
        handle_line(l, &mut on_line);
    }
    if status.is_none() {
        status = child.try_wait().ok().flatten();
    }
    #[cfg(unix)]
    if let Some(pid) = pid {
        signal_group(pid, libc::SIGKILL);
    }
    if let Some(slot) = &pgid_out {
        slot.store(0, Ordering::SeqCst);
    }
    let mut tail = match tokio::time::timeout(PIPE_DRAIN_GRACE, err_task).await {
        Ok(Ok(t)) => t,
        _ => Vec::new(),
    };
    if splitter.dropped > 0 {
        tail.extend_from_slice(
            format!(
                "\n[json-gantt] dropped {} stdout line(s) over {} bytes\n",
                splitter.dropped, MAX_LINE_BYTES
            )
            .as_bytes(),
        );
    }
    Ok(Outcome {
        exit: AiExit {
            code: status.and_then(|s| s.code()),
            stopped,
            timed_out,
        },
        stderr_tail: String::from_utf8_lossy(&tail).into_owned(),
        last_result_line: last_result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    // ---- R1
    #[test]
    fn r1_resolve_priority_and_searched_order() {
        let home = p("/h");
        let setting = p("/custom/claude");
        let path_env = OsString::from("/x/bin");
        let all: HashSet<PathBuf> = candidates(Some(&setting), Some(&home), Some(&path_env))
            .into_iter()
            .collect();
        // setting wins when executable
        let r = resolve_claude(Some(&setting), Some(&home), Some(&path_env), |c| {
            all.contains(c)
        });
        assert_eq!(r.unwrap(), setting);
        // invalid setting falls through; ~/.local/bin beats /opt/homebrew/bin
        let ok: HashSet<PathBuf> =
            [p("/h/.local/bin/claude"), p("/opt/homebrew/bin/claude")].into();
        let r = resolve_claude(Some(&setting), Some(&home), Some(&path_env), |c| {
            ok.contains(c)
        });
        assert_eq!(r.unwrap(), p("/h/.local/bin/claude"));
        // nothing: full list in order
        let r = resolve_claude(Some(&setting), Some(&home), Some(&path_env), |_| false);
        assert_eq!(
            r.unwrap_err(),
            vec![
                p("/custom/claude"),
                p("/h/.local/bin/claude"),
                p("/h/.claude/local/claude"),
                p("/opt/homebrew/bin/claude"),
                p("/usr/local/bin/claude"),
                p("/x/bin/claude"),
            ]
        );
    }

    // ---- R2
    #[test]
    fn r2_resolve_path_env_skips_empty_and_missing_dirs() {
        let path_env = std::env::join_paths(["", "/nope", "/y/bin"]).unwrap();
        let r = resolve_claude(None, None, Some(&path_env), |c| {
            c == Path::new("/y/bin/claude")
        });
        assert_eq!(r.unwrap(), p("/y/bin/claude"));
        let list = resolve_claude(None, None, Some(&path_env), |_| false).unwrap_err();
        assert!(list.contains(&p("/nope/claude")));
        assert!(!list.iter().any(|c| c == Path::new("claude")));
    }

    // ---- R3
    #[test]
    fn r3_build_args_shape() {
        let id = "bdd5bdc5-8d12-4181-b34a-e70717bf6318";
        let a = build_args("SYS", Some(id), "PROMPT").unwrap();
        let s: Vec<String> = a.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        let has = |pair: &[&str]| s.windows(pair.len()).any(|w| w == pair);
        assert!(has(&["--tools", "Read,Edit"]));
        assert!(has(&["--permission-prompts", "none"]));
        assert!(has(&["--append-system-prompt", "SYS"]));
        assert!(has(&["--resume", id]));
        assert!(s.contains(&"--strict-mcp-config".to_string()));
        assert!(s.contains(&"--restricted".to_string()));
        assert!(has(&["--allowedTools", "Read,Edit"]));
        assert!(has(&["--permission-mode", "acceptEdits"]));
        assert!(s.contains(&"--disable-slash-commands".to_string()));
        assert_eq!(&s[s.len() - 3..], ["--setting-sources", "", "PROMPT"]);
        let b = build_args("SYS", None, "PROMPT").unwrap();
        assert!(!b.iter().any(|x| x == "--resume"));
        assert_eq!(b.last().unwrap(), "PROMPT");
    }

    // ---- R4
    #[test]
    fn r4_build_args_rejects_bad_session_id() {
        let dashes = "-".repeat(36);
        let misplaced = "bdd5bdc58d12-4181-b34a-e70717bf6318-"; // 36 chars, dashes in the wrong places
        let nonhex = "gdd5bdc5-8d12-4181-b34a-e70717bf6318";
        for bad in [
            "--foo",
            "",
            &"a".repeat(37),
            &"g".repeat(36),
            dashes.as_str(),
            misplaced,
            nonhex,
        ] {
            assert!(
                matches!(build_args("S", Some(bad), "P"), Err(AppError::Ai { .. })),
                "{bad}"
            );
        }
    }

    #[test]
    fn r4b_build_args_rejects_dash_prompt() {
        assert!(matches!(
            build_args("S", None, "--version"),
            Err(AppError::Ai { .. })
        ));
        assert!(build_args("S", None, "[アプリからの文脈]").is_ok());
    }

    // ---- R5
    #[test]
    fn r5_scrub_env() {
        let mut cmd = Command::new("x");
        scrub_env(&mut cmd, Path::new("/opt/c/claude"));
        let envs: Vec<_> = cmd.as_std().get_envs().collect();
        assert!(envs.iter().any(|(k, v)| *k == "CLAUDECODE" && v.is_none()));
        let path = envs
            .iter()
            .find(|(k, _)| *k == "PATH")
            .and_then(|(_, v)| *v)
            .unwrap();
        let first = std::env::split_paths(path).next().unwrap();
        assert_eq!(first, p("/opt/c"));
        #[cfg(unix)]
        {
            let joined = scrubbed_path(Path::new("/opt/c/claude"), Some(OsStr::new("/usr/bin")));
            let v: Vec<_> = std::env::split_paths(&joined).collect();
            assert_eq!(
                v,
                [
                    p("/opt/c"),
                    p("/opt/homebrew/bin"),
                    p("/usr/local/bin"),
                    p("/usr/bin")
                ]
            );
        }
    }

    // ---- R6
    #[test]
    fn r6_line_splitter() {
        let mut s = LineSplitter::default();
        assert_eq!(s.push(b"ab"), Vec::<String>::new());
        assert_eq!(s.push(b"c\r\nde\n\nf"), ["abc", "de", ""]);
        assert_eq!(s.finish().as_deref(), Some("f"));
        assert_eq!(s.finish(), None);
        // multi-byte char split across chunks
        let bytes = "あい\n".as_bytes();
        let mut s = LineSplitter::default();
        assert!(s.push(&bytes[..2]).is_empty());
        assert_eq!(s.push(&bytes[2..]), ["あい"]);
        // invalid UTF-8 is replaced
        let mut s = LineSplitter::default();
        assert_eq!(s.push(b"a\xffb\n"), ["a\u{fffd}b"]);
    }

    // ---- R7 (see also error.rs)
    #[test]
    fn r7_error_kinds() {
        let v = serde_json::to_value(AppError::Ai {
            message: "m".into(),
        })
        .unwrap();
        assert_eq!(v["kind"], "AI");
        let v = serde_json::to_value(AppError::AiNotFound {
            searched: vec!["a".into()],
        })
        .unwrap();
        assert_eq!(v["kind"], "AI_NOT_FOUND");
        assert_eq!(v["searched"][0], "a");
    }

    #[test]
    fn file_result_json_shape() {
        let v = serde_json::to_value(AiFileResult::Unchanged).unwrap();
        assert_eq!(v, serde_json::json!({"status": "unchanged"}));
        let v = serde_json::to_value(AiFileResult::Invalid {
            error: AppError::Ai {
                message: "m".into(),
            },
        })
        .unwrap();
        assert_eq!(v["status"], "invalid");
        assert_eq!(v["error"]["kind"], "AI");
        let v = serde_json::to_value(AiExit {
            code: Some(0),
            stopped: false,
            timed_out: true,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"code": 0, "stopped": false, "timedOut": true})
        );
    }

    // ---- process tests (unix, fake scripts)
    #[cfg(unix)]
    mod proc {
        use super::*;

        fn fixture(name: &str) -> PathBuf {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name)
        }

        fn session() -> (tempfile::TempDir, Hash) {
            let dir = tempfile::Builder::new()
                .prefix(TEMP_PREFIX)
                .tempdir()
                .unwrap();
            let doc: Value =
                serde_json::from_str(include_str!("../tests/fixtures/sample.json")).unwrap();
            let h = write_session_files(dir.path(), doc).unwrap();
            (dir, h)
        }

        async fn run(script: &str, dir: &Path) -> (Outcome, Vec<String>) {
            let (_tx, rx) = watch::channel(false);
            let mut lines = Vec::new();
            let o = run_process(&fixture(script), &[], dir, rx, RunOpts::default(), |l| {
                lines.push(l.to_string())
            })
            .await
            .unwrap();
            (o, lines)
        }

        // ---- R8
        #[tokio::test]
        async fn r8_run_process_ok_changed() {
            let (dir, h) = session();
            let (o, lines) = run("fake-claude-ok.sh", dir.path()).await;
            let probe = std::fs::read_to_string(fixture("probe.jsonl")).unwrap();
            let expect: Vec<&str> = probe.lines().collect();
            assert_eq!(lines, expect);
            assert_eq!(o.exit.code, Some(0));
            assert!(!o.exit.stopped && !o.exit.timed_out);
            assert_eq!(
                o.last_result_line.as_deref(),
                Some(expect[expect.len() - 1])
            );
            match read_back(dir.path(), &h) {
                AiFileResult::Changed { document, .. } => {
                    assert_eq!(document["project"]["name"], "AI Edited")
                }
                other => panic!("{other:?}"),
            }
        }

        // ---- R9
        #[tokio::test]
        async fn r9_run_process_unchanged_invalid_missing() {
            let (dir, h) = session();
            run("fake-claude-noop.sh", dir.path()).await;
            assert!(matches!(read_back(dir.path(), &h), AiFileResult::Unchanged));
            run("fake-claude-broken.sh", dir.path()).await;
            match read_back(dir.path(), &h) {
                AiFileResult::Invalid { error } => {
                    assert!(matches!(error, AppError::ParseError { .. }))
                }
                other => panic!("{other:?}"),
            }
            run("fake-claude-delete.sh", dir.path()).await;
            assert!(matches!(read_back(dir.path(), &h), AiFileResult::Missing));
        }

        // ---- R10
        #[tokio::test]
        async fn r10_run_process_cancel_kills_group() {
            let (dir, _h) = session();
            let (tx, rx) = watch::channel(false);
            let start = std::time::Instant::now();
            let pid_file = dir.path().join("sleep.pid");
            tokio::spawn(async move {
                for _ in 0..200 {
                    if pid_file.exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                let _ = tx.send(true);
                // keep the sender alive a little
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
            let o = run_process(
                &fixture("fake-claude-sleep.sh"),
                &[],
                dir.path(),
                rx,
                RunOpts::default(),
                |_| {},
            )
            .await
            .unwrap();
            assert!(
                start.elapsed() < Duration::from_millis(3500),
                "{:?}",
                start.elapsed()
            );
            assert!(o.exit.stopped);
            let pid: i32 = std::fs::read_to_string(dir.path().join("sleep.pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let mut gone = false;
            for _ in 0..20 {
                // SAFETY: signal 0 only checks existence.
                if unsafe { libc::kill(pid, 0) } != 0 {
                    gone = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(gone, "background sleep survived");
        }

        #[tokio::test]
        async fn r10_idle_timeout_stops_process() {
            let (dir, _h) = session();
            let (_tx, rx) = watch::channel(false);
            let o = run_process(
                &fixture("fake-claude-sleep.sh"),
                &[],
                dir.path(),
                rx,
                RunOpts {
                    timeouts: Timeouts {
                        turn: Duration::from_secs(60),
                        idle: Duration::from_millis(700),
                    },
                    ..RunOpts::default()
                },
                |_| {},
            )
            .await
            .unwrap();
            assert!(o.exit.timed_out && !o.exit.stopped);
        }

        // ---- R11
        #[tokio::test]
        async fn r11_run_process_cwd_and_env() {
            let (dir, _h) = session();
            let (_tx, rx) = watch::channel(false);
            let mut lines = Vec::new();
            let log = dir.path().join("args.log");
            let o = run_process(
                &fixture("fake-claude-env.sh"),
                &[],
                dir.path(),
                rx,
                RunOpts {
                    // The parent's CLAUDECODE must not reach the child.
                    extra_env: vec![
                        ("CLAUDECODE".into(), "1".into()),
                        ("FAKE_CLAUDE_ARGS_LOG".into(), log.clone().into()),
                    ],
                    ..RunOpts::default()
                },
                |l| lines.push(l.to_string()),
            )
            .await
            .unwrap();
            assert_eq!(o.exit.code, Some(0));
            let cwd = std::fs::canonicalize(dir.path()).unwrap();
            assert!(
                lines.contains(&format!("CWD={}", cwd.display())),
                "{lines:?}"
            );
            assert!(lines.contains(&"CLAUDECODE=unset".to_string()), "{lines:?}");
            let path_line = lines.iter().find(|l| l.starts_with("PATH=")).unwrap();
            let fx = fixture("x").parent().unwrap().display().to_string();
            assert!(path_line.starts_with(&format!("PATH={fx}")), "{path_line}");
            // The args log is written only when the variable is set.
            assert!(log.exists());
        }

        #[tokio::test]
        async fn precancelled_run_does_not_spawn() {
            let (dir, h) = session();
            let (_tx, rx) = watch::channel(true);
            let o = run_process(
                &fixture("fake-claude-ok.sh"),
                &[],
                dir.path(),
                rx,
                RunOpts::default(),
                |_| panic!("no output expected"),
            )
            .await
            .unwrap();
            assert!(o.exit.stopped && o.exit.code.is_none());
            assert!(matches!(read_back(dir.path(), &h), AiFileResult::Unchanged));
        }

        fn alive(pid: i32) -> bool {
            // SAFETY: signal 0 only checks existence.
            unsafe { libc::kill(pid, 0) == 0 }
        }

        fn read_pid(dir: &Path) -> i32 {
            for _ in 0..100 {
                if let Ok(s) = std::fs::read_to_string(dir.join("sleep.pid"))
                    && let Ok(p) = s.trim().parse()
                {
                    return p;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            panic!("sleep.pid not written");
        }

        /// A killed process may linger as a zombie until init reaps it.
        fn gone_blocking(pid: i32, within: Duration) -> bool {
            let t = std::time::Instant::now();
            while t.elapsed() < within {
                if !alive(pid) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            !alive(pid)
        }

        async fn gone(pid: i32, within: Duration) -> bool {
            let t = std::time::Instant::now();
            while t.elapsed() < within {
                if !alive(pid) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            !alive(pid)
        }

        // ---- kill_groups_blocking (synchronous kill on exit)
        #[test]
        fn kill_groups_blocking_term_and_kill() {
            use std::os::unix::process::CommandExt;
            for (script, min, max) in [
                ("fake-claude-sleep.sh", 0u64, 1000u64),
                ("fake-claude-stubborn.sh", 900, 1600),
            ] {
                let (dir, _h) = session();
                let mut child = std::process::Command::new(fixture(script))
                    .current_dir(dir.path())
                    .process_group(0)
                    .stdout(Stdio::null())
                    .spawn()
                    .unwrap();
                let sleep_pid = read_pid(dir.path());
                let pgid = child.id();
                let t = std::time::Instant::now();
                kill_groups_blocking(&[pgid], EXIT_KILL_GRACE);
                let ms = t.elapsed().as_millis() as u64;
                assert!(ms >= min && ms < max, "{script}: {ms} ms");
                assert!(
                    gone_blocking(sleep_pid, Duration::from_millis(500)),
                    "{script}: grandchild survived"
                );
                // The leader was reaped by kill_groups_blocking or is reapable now.
                let _ = child.wait();
                assert!(!signal_group(pgid, 0), "{script}: group survived");
            }
        }

        // ---- Major 1: remove_all_ai / remove_ai kill the group synchronously
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn remove_all_ai_kills_process_group_within_1500ms() {
            for (script, via_window) in [
                ("fake-claude-sleep.sh", false),
                ("fake-claude-stubborn.sh", false),
                ("fake-claude-sleep.sh", true),
            ] {
                let (dir, _h) = session();
                let dir_path = dir.path().to_path_buf();
                let state = Arc::new(crate::state::AppState::default());
                let mut sess = crate::state::AiSession::new(dir);
                let (rx, pgid) = sess.register_run("r1").unwrap();
                state.ai.lock().unwrap().insert("main".into(), sess);
                let task = {
                    let dir_path = dir_path.clone();
                    tokio::spawn(async move {
                        run_process(
                            &fixture(script),
                            &[],
                            &dir_path,
                            rx,
                            RunOpts {
                                pgid_out: Some(pgid),
                                ..RunOpts::default()
                            },
                            |_| {},
                        )
                        .await
                    })
                };
                let sleep_pid = read_pid(&dir_path);
                let st = state.clone();
                let t = std::time::Instant::now();
                tokio::task::spawn_blocking(move || {
                    if via_window {
                        st.remove_ai("main")
                    } else {
                        st.remove_all_ai()
                    }
                })
                .await
                .unwrap();
                assert!(
                    t.elapsed() < Duration::from_millis(1500),
                    "{script}: {:?}",
                    t.elapsed()
                );
                assert!(
                    gone(sleep_pid, Duration::from_millis(500)).await,
                    "{script}: grandchild survived"
                );
                assert!(state.ai.lock().unwrap().is_empty());
                assert!(!dir_path.exists(), "temp dir not deleted");
                let o = tokio::time::timeout(Duration::from_secs(3), task)
                    .await
                    .expect("run_process finished")
                    .unwrap()
                    .unwrap();
                assert!(o.exit.stopped);
            }
        }

        #[tokio::test]
        async fn normal_exit_kills_orphaned_grandchild_quickly() {
            // sh exits at once while its background sleep keeps the pipes open.
            let (dir, _h) = session();
            let script = dir.path().join("orphan.sh");
            std::fs::write(
                &script,
                "#!/bin/sh\nsleep 30 &\necho $! > sleep.pid\nexit 0\n",
            )
            .unwrap();
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            let (_tx, rx) = watch::channel(false);
            let t = std::time::Instant::now();
            let o = run_process(&script, &[], dir.path(), rx, RunOpts::default(), |_| {})
                .await
                .unwrap();
            assert!(
                t.elapsed() < Duration::from_millis(1000),
                "{:?}",
                t.elapsed()
            );
            assert_eq!(o.exit.code, Some(0));
            let sleep_pid = read_pid(dir.path());
            assert!(gone(sleep_pid, Duration::from_millis(500)).await);
        }
    }

    // ---- R12
    #[test]
    fn r12_tempdir_drop_and_cleanup() {
        let d = tempfile::Builder::new()
            .prefix(TEMP_PREFIX)
            .tempdir()
            .unwrap();
        let path = d.path().to_path_buf();
        assert!(path.exists());
        drop(d);
        assert!(!path.exists());

        let base = tempfile::tempdir().unwrap();
        let ours = base.path().join(format!("{TEMP_PREFIX}abc"));
        let other = base.path().join("other-dir");
        let file = base.path().join(format!("{TEMP_PREFIX}file"));
        std::fs::create_dir(&ours).unwrap();
        std::fs::create_dir(&other).unwrap();
        std::fs::write(&file, "x").unwrap();
        // not old enough
        assert_eq!(cleanup_stale(base.path(), Duration::from_secs(3600)), 0);
        assert!(ours.exists());
        assert_eq!(cleanup_stale(base.path(), Duration::ZERO), 1);
        assert!(!ours.exists());
        assert!(other.exists() && file.exists());
    }
}
