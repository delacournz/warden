//! Local transport and host election for the single-instance viewer.
//!
//! Every CLI-spawned process is a headless relay that talks over an owner-only local socket
//! (unix socket / Windows named pipe) to ONE detached `warden-viewer --host` process. This module
//! is the transport and the election only. Frames are one JSON object per `\n`-terminated line.
//!
//! The viewer token travels inside `Open.line`/`Refresh.line`, so: the socket and its directory
//! are owner-only, peers with another uid are dropped, and no error or log here ever includes a
//! frame's text.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};

pub const PROTO: u32 = 1;
/// A longer line is an error (`InvalidData`).
pub const MAX_FRAME: usize = 64 * 1024;

/// Relay to host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ToHost {
    /// `line` = the CLI's raw first stdin line (the relay validates it; the host re-parses it).
    Open { proto: u32, line: String },
    /// A later raw stdin line (token refresh).
    Refresh { line: String },
    /// The CLI closed stdin.
    Eof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseReason {
    Window,
    Eof,
    Detached,
    Superseded,
    Shutdown,
}

/// Host to relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ToRelay {
    Ready,
    Streaming,
    /// The user closed the window from its prompt; `release` = Shut down. Attached only.
    Close {
        release: bool,
    },
    Closed {
        reason: CloseReason,
    },
    Error {
        message: String,
    },
}

/// One frame as a JSON line including the trailing `\n`.
pub fn encode<T: Serialize>(frame: &T) -> String {
    // The frame types are plain data; serialising them cannot fail. Fall back to an empty
    // object rather than panicking.
    let mut s = serde_json::to_string(frame).unwrap_or_else(|_| "{}".to_string());
    s.push('\n');
    s
}

/// Next frame, `None` on clean EOF. Blank lines are skipped. The error never includes the line:
/// it may hold the token.
pub async fn read_frame<R: AsyncBufRead + Unpin, T: DeserializeOwned>(
    r: &mut R,
) -> io::Result<Option<T>> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let n = (&mut *r)
            .take(MAX_FRAME as u64 + 1)
            .read_until(b'\n', &mut buf)
            .await?;
        if n == 0 {
            return Ok(None);
        }
        if buf.last() != Some(&b'\n') && buf.len() > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame exceeds the maximum length",
            ));
        }
        let line = buf.trim_ascii();
        if line.is_empty() {
            continue;
        }
        return match serde_json::from_slice::<T>(line) {
            Ok(v) => Ok(Some(v)),
            Err(e) => Err(io::Error::new(io::ErrorKind::InvalidData, redact(&e))),
        };
    }
}

/// Syntax errors carry no input text; data errors can quote a value (an unknown variant, a
/// string), so those are reduced to their position.
fn redact(e: &serde_json::Error) -> String {
    match e.classify() {
        serde_json::error::Category::Data => {
            format!(
                "invalid frame shape at line {} column {}",
                e.line(),
                e.column()
            )
        }
        _ => format!("invalid frame: {e}"),
    }
}

pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    w: &mut W,
    frame: &T,
) -> io::Result<()> {
    w.write_all(encode(frame).as_bytes()).await?;
    w.flush().await
}

/// A connected peer, split into a buffered reader and a writer.
pub struct Conn {
    pub reader: BufReader<Box<dyn AsyncRead + Send + Unpin>>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
}

impl Conn {
    fn new<R, W>(r: R, w: W) -> Conn
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Conn {
            reader: BufReader::new(Box::new(r)),
            writer: Box::new(w),
        }
    }
}

/// `{version}-{h}`: h is 8 hex chars folded from an FNV-1a 64 of the exe path's bytes. Stable
/// across builds, so each install path and each dev build gets its own host.
pub fn instance_key(version: &str, exe: &Path) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in exe.as_os_str().as_encoded_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let folded = (h ^ (h >> 32)) as u32;
    format!("{version}-{folded:08x}")
}

// ---- election -------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Connected,
    /// The socket file exists and nobody listens.
    Refused,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayStep {
    Use,
    Spawn,
    UnlinkAndSpawn,
}

pub fn relay_decision(p: Probe) -> RelayStep {
    match p {
        Probe::Connected => RelayStep::Use,
        Probe::Missing => RelayStep::Spawn,
        Probe::Refused => RelayStep::UnlinkAndSpawn,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostStep {
    Bind,
    UnlinkAndBind,
    AnotherHost,
}

pub fn host_decision(p: Probe) -> HostStep {
    match p {
        Probe::Missing => HostStep::Bind,
        Probe::Refused => HostStep::UnlinkAndBind,
        Probe::Connected => HostStep::AnotherHost,
    }
}

// ---- endpoint (unix) ------------------------------------------------------------------------

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub socket: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
}

/// Directory for the socket files. `sun_path` is 104 bytes on macOS, so a long `$TMPDIR` falls
/// back to `/tmp/warden-viewer-{uid}`.
#[cfg(unix)]
pub fn socket_dir(tmpdir: &Path, uid: u32, key: &str) -> PathBuf {
    let preferred = tmpdir.join("warden-viewer");
    if preferred.join(format!("{key}.sock")).as_os_str().len() >= 100 {
        PathBuf::from(format!("/tmp/warden-viewer-{uid}"))
    } else {
        preferred
    }
}

#[cfg(unix)]
pub fn endpoint_in(dir: &Path, key: &str) -> Endpoint {
    Endpoint {
        socket: dir.join(format!("{key}.sock")),
        lock: dir.join(format!("{key}.lock")),
        log: dir.join(format!("{key}.log")),
    }
}

#[cfg(unix)]
pub fn endpoint(key: &str) -> io::Result<Endpoint> {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    let dir = socket_dir(&std::env::temp_dir(), uid, key);
    ensure_private_dir(&dir)?;
    Ok(endpoint_in(&dir, key))
}

/// Create `dir` as 0700, or accept an existing real directory we own (tightened to 0700). A
/// symlink or a directory owned by someone else is `PermissionDenied`.
#[cfg(unix)]
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    for _ in 0..2 {
        match verify_private_dir(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if let Some(parent) = dir.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                match std::fs::DirBuilder::new().mode(0o700).create(dir) {
                    Ok(()) => {
                        // The umask only removes bits; this makes the result exact.
                        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
                        return Ok(());
                    }
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
    verify_private_dir(dir)
}

#[cfg(unix)]
fn verify_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let md = std::fs::symlink_metadata(dir)?;
    if !md.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket directory is not a real directory",
        ));
    }
    // SAFETY: getuid has no preconditions and cannot fail.
    if md.uid() != unsafe { libc::getuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket directory is owned by another user",
        ));
    }
    if md.permissions().mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Exclusive advisory lock on the instance's lock file; released on drop.
#[cfg(unix)]
pub struct LockGuard {
    file: std::fs::File,
}

#[cfg(unix)]
impl Drop for LockGuard {
    fn drop(&mut self) {
        use std::os::unix::io::AsRawFd;
        // SAFETY: the fd is owned by `self.file` and valid until the file drops after this.
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

/// Blocking `LOCK_EX`; run it through `spawn_blocking` from async callers.
#[cfg(unix)]
pub fn lock_exclusive(path: &Path) -> io::Result<LockGuard> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;

    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(path)?;
    loop {
        // SAFETY: the fd is valid for the lifetime of `file`.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if rc == 0 {
            return Ok(LockGuard { file });
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

#[cfg(unix)]
async fn lock_async(path: &Path) -> io::Result<LockGuard> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || lock_exclusive(&path))
        .await
        .map_err(|e| io::Error::other(e.to_string()))?
}

#[cfg(unix)]
async fn probe(ep: &Endpoint) -> Probe {
    match tokio::net::UnixStream::connect(&ep.socket).await {
        Ok(_) => Probe::Connected,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Probe::Missing,
        Err(_) => {
            if std::fs::symlink_metadata(&ep.socket).is_ok() {
                Probe::Refused
            } else {
                Probe::Missing
            }
        }
    }
}

#[cfg(unix)]
fn unlink(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
fn unix_conn(s: tokio::net::UnixStream) -> Conn {
    let (r, w) = s.into_split();
    Conn::new(r, w)
}

#[cfg(unix)]
pub async fn connect(ep: &Endpoint) -> io::Result<Conn> {
    tokio::net::UnixStream::connect(&ep.socket)
        .await
        .map(unix_conn)
}

#[cfg(unix)]
pub struct Listener {
    inner: tokio::net::UnixListener,
    #[cfg_attr(not(test), allow(dead_code))]
    path: PathBuf,
    uid: u32,
}

#[cfg(unix)]
impl Listener {
    /// Bind under the instance lock. `AddrInUse` when another host already listens.
    pub async fn bind(ep: &Endpoint) -> io::Result<Listener> {
        use std::os::unix::fs::PermissionsExt;

        let _guard = lock_async(&ep.lock).await?;
        match host_decision(probe(ep).await) {
            HostStep::AnotherHost => {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another viewer host is already listening",
                ))
            }
            HostStep::UnlinkAndBind => unlink(&ep.socket),
            HostStep::Bind => {}
        }
        let inner = tokio::net::UnixListener::bind(&ep.socket)?;
        std::fs::set_permissions(&ep.socket, std::fs::Permissions::from_mode(0o600))?;
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        Ok(Listener {
            inner,
            path: ep.socket.clone(),
            uid,
        })
    }

    /// Next peer owned by our uid; any other peer is dropped.
    pub async fn accept(&mut self) -> io::Result<Conn> {
        loop {
            let (s, _) = self.inner.accept().await?;
            match s.peer_cred() {
                Ok(c) if c.uid() == self.uid => return Ok(unix_conn(s)),
                _ => continue,
            }
        }
    }

    /// Unlink the socket file (best effort). Drop does not unlink. The app's host never returns
    /// its listener from the accept loop and unlinks through its `Endpoint` at exit instead.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn close(self) {
        unlink(&self.path);
    }
}

/// Connect, or elect-and-spawn a host under the lock then retry. `spawn` runs at most once.
#[cfg(unix)]
async fn elect_and_spawn<F: FnMut() -> io::Result<()>>(
    ep: &Endpoint,
    spawn: &mut F,
) -> io::Result<()> {
    let _guard = lock_async(&ep.lock).await?;
    match relay_decision(probe(ep).await) {
        RelayStep::Use => Ok(()),
        RelayStep::Spawn => spawn(),
        RelayStep::UnlinkAndSpawn => {
            unlink(&ep.socket);
            spawn()
        }
    }
}

// ---- endpoint (windows) ---------------------------------------------------------------------

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub pipe: String,
    pub log: PathBuf,
}

/// `\\.\pipe\warden-viewer-{key}-{user}`, user reduced to `[A-Za-z0-9_.-]`.
#[cfg_attr(unix, allow(dead_code))]
pub fn pipe_name(key: &str, user: &str) -> String {
    let user: String = user
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!(r"\\.\pipe\warden-viewer-{key}-{user}")
}

#[cfg(windows)]
pub fn endpoint(key: &str) -> io::Result<Endpoint> {
    let user = std::env::var("USERNAME").unwrap_or_default();
    let dir = std::env::temp_dir().join("warden-viewer");
    std::fs::create_dir_all(&dir)?;
    Ok(Endpoint {
        pipe: pipe_name(key, &user),
        log: dir.join(format!("{key}.log")),
    })
}

#[cfg(windows)]
const ERROR_PIPE_BUSY: i32 = 231;
#[cfg(windows)]
const ERROR_ACCESS_DENIED: i32 = 5;

#[cfg(windows)]
pub async fn connect(ep: &Endpoint) -> io::Result<Conn> {
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut tries = 0;
    loop {
        match ClientOptions::new().open(&ep.pipe) {
            Ok(c) => {
                let (r, w) = tokio::io::split(c);
                return Ok(Conn::new(r, w));
            }
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < 20 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(windows)]
pub struct Listener {
    pipe: String,
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
impl Listener {
    /// `AddrInUse` when another host already owns the pipe.
    pub async fn bind(ep: &Endpoint) -> io::Result<Listener> {
        use tokio::net::windows::named_pipe::ServerOptions;

        let next = ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(&ep.pipe)
            .map_err(|e| {
                if e.kind() == io::ErrorKind::PermissionDenied
                    || e.raw_os_error() == Some(ERROR_ACCESS_DENIED)
                    || e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                {
                    io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "another viewer host is already listening",
                    )
                } else {
                    e
                }
            })?;
        Ok(Listener {
            pipe: ep.pipe.clone(),
            next,
        })
    }

    pub async fn accept(&mut self) -> io::Result<Conn> {
        use tokio::net::windows::named_pipe::ServerOptions;

        self.next.connect().await?;
        let fresh = ServerOptions::new()
            .reject_remote_clients(true)
            .create(&self.pipe)?;
        let connected = std::mem::replace(&mut self.next, fresh);
        let (r, w) = tokio::io::split(connected);
        Ok(Conn::new(r, w))
    }

    /// Nothing to unlink: the pipe vanishes with its last instance.
    pub fn close(self) {}
}

// ---- shared I/O -----------------------------------------------------------------------------

/// Connect to the host, spawning one when none answers. `spawn` is called at most once; the
/// connect is retried with 25 ms doubling to 250 ms backoff until `deadline` (`TimedOut`).
pub async fn connect_or_spawn<F: FnMut() -> io::Result<()>>(
    ep: &Endpoint,
    mut spawn: F,
    deadline: Duration,
) -> io::Result<Conn> {
    if let Ok(c) = connect(ep).await {
        return Ok(c);
    }
    let start = Instant::now();
    #[cfg(unix)]
    elect_and_spawn(ep, &mut spawn).await?;
    #[cfg(windows)]
    spawn()?;

    let mut backoff = Duration::from_millis(25);
    loop {
        match connect(ep).await {
            Ok(c) => return Ok(c),
            Err(_) => {
                let elapsed = start.elapsed();
                if elapsed >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the viewer host did not come up in time",
                    ));
                }
                tokio::time::sleep(backoff.min(deadline - elapsed)).await;
                backoff = (backoff * 2).min(Duration::from_millis(250));
            }
        }
    }
}

/// Start `exe --host` detached from this process and its terminal. Stderr appends to `log`.
/// The child is not waited on.
pub fn spawn_host_detached(exe: &Path, log: &Path) -> io::Result<()> {
    let mut cmd = Command::new(exe);
    cmd.arg("--host").stdin(Stdio::null()).stdout(Stdio::null());

    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(log) {
        Ok(f) => cmd.stderr(Stdio::from(f)),
        Err(_) => cmd.stderr(Stdio::null()),
    };

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and only touches the forked child.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    let child = cmd.spawn()?;
    drop(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    fn open_frame() -> ToHost {
        ToHost::Open {
            proto: 1,
            line: "abc".into(),
        }
    }

    #[test]
    fn wire_forms() {
        assert_eq!(
            encode(&open_frame()),
            "{\"t\":\"open\",\"proto\":1,\"line\":\"abc\"}\n"
        );
        assert_eq!(
            encode(&ToHost::Refresh { line: "x".into() }),
            "{\"t\":\"refresh\",\"line\":\"x\"}\n"
        );
        assert_eq!(encode(&ToHost::Eof), "{\"t\":\"eof\"}\n");
        assert_eq!(encode(&ToRelay::Ready), "{\"t\":\"ready\"}\n");
        assert_eq!(encode(&ToRelay::Streaming), "{\"t\":\"streaming\"}\n");
        assert_eq!(
            encode(&ToRelay::Close { release: true }),
            "{\"t\":\"close\",\"release\":true}\n"
        );
        assert_eq!(
            encode(&ToRelay::Closed {
                reason: CloseReason::Superseded
            }),
            "{\"t\":\"closed\",\"reason\":\"superseded\"}\n"
        );
        assert_eq!(
            encode(&ToRelay::Error {
                message: "boom".into()
            }),
            "{\"t\":\"error\",\"message\":\"boom\"}\n"
        );
    }

    #[tokio::test]
    async fn round_trip_over_duplex() {
        let (a, b) = duplex(4096);
        let (_ar, mut aw) = tokio::io::split(a);
        let mut br = BufReader::new(b);
        write_frame(&mut aw, &open_frame()).await.unwrap();
        write_frame(&mut aw, &ToHost::Eof).await.unwrap();
        assert_eq!(
            read_frame::<_, ToHost>(&mut br).await.unwrap(),
            Some(open_frame())
        );
        assert_eq!(
            read_frame::<_, ToHost>(&mut br).await.unwrap(),
            Some(ToHost::Eof)
        );
    }

    #[tokio::test]
    async fn eof_is_none_and_blank_lines_are_skipped() {
        let mut empty = BufReader::new(&b""[..]);
        assert_eq!(read_frame::<_, ToHost>(&mut empty).await.unwrap(), None);
        let mut r = BufReader::new(&b"\n  \n{\"t\":\"eof\"}\n"[..]);
        assert_eq!(
            read_frame::<_, ToHost>(&mut r).await.unwrap(),
            Some(ToHost::Eof)
        );
        assert_eq!(read_frame::<_, ToHost>(&mut r).await.unwrap(), None);
    }

    #[tokio::test]
    async fn oversize_line_is_invalid_data() {
        let mut big = vec![b'a'; MAX_FRAME + 10];
        big.push(b'\n');
        let mut r = BufReader::new(&big[..]);
        let err = read_frame::<_, ToHost>(&mut r).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        let mut nonl = BufReader::new(&big[..big.len() - 1]);
        let err = read_frame::<_, ToHost>(&mut nonl).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn bad_json_error_does_not_leak_the_line() {
        for line in [
            "not json wvt_secret\n",
            "{\"t\":\"wvt_secret\"}\n",
            "{\"t\":\"open\",\"proto\":\"wvt_secret\",\"line\":\"x\"}\n",
            "\"wvt_secret\"\n",
        ] {
            let mut r = BufReader::new(line.as_bytes());
            let err = read_frame::<_, ToHost>(&mut r).await.unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidData);
            assert!(!err.to_string().contains("wvt_secret"), "{err}");
        }
    }

    #[test]
    fn instance_key_is_deterministic_and_path_sensitive() {
        let a = instance_key("0.0.0", Path::new("/Applications/warden viewer.app/x"));
        assert_eq!(
            a,
            instance_key("0.0.0", Path::new("/Applications/warden viewer.app/x"))
        );
        assert_ne!(a, instance_key("0.0.0", Path::new("/tmp/other/x")));
        let b = a.strip_prefix("0.0.0-").unwrap();
        assert_eq!(b.len(), 8);
        assert!(b
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    }

    #[test]
    fn decision_tables() {
        assert_eq!(relay_decision(Probe::Connected), RelayStep::Use);
        assert_eq!(relay_decision(Probe::Missing), RelayStep::Spawn);
        assert_eq!(relay_decision(Probe::Refused), RelayStep::UnlinkAndSpawn);
        assert_eq!(host_decision(Probe::Missing), HostStep::Bind);
        assert_eq!(host_decision(Probe::Refused), HostStep::UnlinkAndBind);
        assert_eq!(host_decision(Probe::Connected), HostStep::AnotherHost);
    }

    #[test]
    fn pipe_name_sanitises_the_user() {
        assert_eq!(
            pipe_name("1.0-ab", "A B\\c"),
            r"\\.\pipe\warden-viewer-1.0-ab-A_B_c"
        );
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        struct TestDir(PathBuf);
        impl TestDir {
            fn new() -> TestDir {
                static N: AtomicUsize = AtomicUsize::new(0);
                let p = PathBuf::from(format!(
                    "/tmp/wv-{}-{}",
                    std::process::id(),
                    N.fetch_add(1, Ordering::Relaxed)
                ));
                std::fs::create_dir_all(&p).unwrap();
                TestDir(p)
            }
        }
        impl Drop for TestDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        fn ep(d: &TestDir) -> Endpoint {
            endpoint_in(&d.0, "k")
        }

        #[test]
        fn socket_dir_falls_back_when_tmpdir_is_long() {
            let short = Path::new("/tmp");
            assert_eq!(
                socket_dir(short, 501, "0.1.0-abcd1234"),
                short.join("warden-viewer")
            );
            let long = Path::new(
                "/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123456789/T/more/long/and/longer/still",
            );
            assert_eq!(
                socket_dir(long, 501, "0.1.0-abcd1234"),
                PathBuf::from("/tmp/warden-viewer-501")
            );
        }

        #[test]
        fn endpoint_in_names() {
            let e = endpoint_in(Path::new("/d"), "k");
            assert_eq!(e.socket, Path::new("/d/k.sock"));
            assert_eq!(e.lock, Path::new("/d/k.lock"));
            assert_eq!(e.log, Path::new("/d/k.log"));
        }

        #[test]
        fn private_dir_created_0700() {
            let t = TestDir::new();
            let d = t.0.join("sub");
            ensure_private_dir(&d).unwrap();
            assert_eq!(std::fs::metadata(&d).unwrap().mode() & 0o777, 0o700);
        }

        #[test]
        fn private_dir_tightened() {
            let t = TestDir::new();
            let d = t.0.join("sub");
            std::fs::create_dir(&d).unwrap();
            std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
            ensure_private_dir(&d).unwrap();
            assert_eq!(std::fs::metadata(&d).unwrap().mode() & 0o777, 0o700);
        }

        #[test]
        fn private_dir_refuses_symlink() {
            let t = TestDir::new();
            let real = t.0.join("real");
            std::fs::create_dir(&real).unwrap();
            let link = t.0.join("link");
            symlink(&real, &link).unwrap();
            let err = ensure_private_dir(&link).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        }

        #[tokio::test]
        async fn two_clients_exchange_frames_independently() {
            let t = TestDir::new();
            let e = ep(&t);
            let mut l = Listener::bind(&e).await.unwrap();
            let mode = std::fs::metadata(&e.socket).unwrap().mode() & 0o777;
            assert_eq!(mode, 0o600);

            let mut c1 = connect(&e).await.unwrap();
            let mut s1 = l.accept().await.unwrap();
            let mut c2 = connect(&e).await.unwrap();
            let mut s2 = l.accept().await.unwrap();

            write_frame(&mut c1.writer, &ToHost::Refresh { line: "one".into() })
                .await
                .unwrap();
            write_frame(&mut c2.writer, &ToHost::Refresh { line: "two".into() })
                .await
                .unwrap();
            assert_eq!(
                read_frame::<_, ToHost>(&mut s2.reader).await.unwrap(),
                Some(ToHost::Refresh { line: "two".into() })
            );
            assert_eq!(
                read_frame::<_, ToHost>(&mut s1.reader).await.unwrap(),
                Some(ToHost::Refresh { line: "one".into() })
            );
            write_frame(&mut s1.writer, &ToRelay::Ready).await.unwrap();
            write_frame(&mut s2.writer, &ToRelay::Streaming)
                .await
                .unwrap();
            assert_eq!(
                read_frame::<_, ToRelay>(&mut c2.reader).await.unwrap(),
                Some(ToRelay::Streaming)
            );
            assert_eq!(
                read_frame::<_, ToRelay>(&mut c1.reader).await.unwrap(),
                Some(ToRelay::Ready)
            );
            l.close();
            assert!(!e.socket.exists());
        }

        #[tokio::test]
        async fn stale_socket_is_replaced() {
            let t = TestDir::new();
            let e = ep(&t);
            drop(std::os::unix::net::UnixListener::bind(&e.socket).unwrap());
            assert!(e.socket.exists());
            assert!(connect(&e).await.is_err());
            let _l = Listener::bind(&e).await.unwrap();
            assert!(connect(&e).await.is_ok());
        }

        #[tokio::test]
        async fn second_bind_is_addr_in_use() {
            let t = TestDir::new();
            let e = ep(&t);
            let _l = Listener::bind(&e).await.unwrap();
            let err = Listener::bind(&e).await.err().unwrap();
            assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
        }

        #[tokio::test]
        async fn connect_or_spawn_runs_spawn_once_and_connects() {
            let t = TestDir::new();
            let e = ep(&t);
            let count = Arc::new(AtomicUsize::new(0));
            let (c2, e2) = (count.clone(), e.clone());
            let conn = connect_or_spawn(
                &e,
                move || {
                    c2.fetch_add(1, Ordering::SeqCst);
                    let e3 = e2.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(60)).await;
                        let mut l = Listener::bind(&e3).await.unwrap();
                        let _c = l.accept().await;
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    });
                    Ok(())
                },
                Duration::from_secs(5),
            )
            .await;
            assert!(conn.is_ok());
            assert_eq!(count.load(Ordering::SeqCst), 1);
        }

        #[tokio::test]
        async fn connect_or_spawn_times_out() {
            let t = TestDir::new();
            let e = ep(&t);
            let r = connect_or_spawn(&e, || Ok(()), Duration::from_millis(300)).await;
            assert_eq!(r.err().unwrap().kind(), io::ErrorKind::TimedOut);
        }
    }
}
