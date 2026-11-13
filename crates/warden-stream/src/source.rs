//! Where access units come from: the helper's stream socket, or a file replayed at a frame rate.
//!
//! Units go through a short queue to the sender. When the sender falls behind and the queue
//! reaches [`BACKLOG`], the whole backlog is cut, a [`SourceEvent::Dropped`] takes its place, and
//! deltas are skipped until the next keyframe: latency never grows, the picture resumes on an IDR.
//! The helper does the same on its side of the socket and forces its own keyframe.

use crate::framing::{self, FrameReader, Unit};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Notify};

/// Units queued for the sender before the backlog is cut.
pub const BACKLOG: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceEvent {
    Unit(Unit),
    /// This many units were cut from a backlog (or skipped waiting for a keyframe after one).
    Dropped(u64),
    /// The source ended: `None` at the end of a file, `Some(reason)` on an error.
    End(Option<String>),
}

#[derive(Default)]
struct State {
    queue: VecDeque<SourceEvent>,
    /// After a cut: skip deltas until a keyframe.
    skip_to_key: bool,
    /// Units skipped since the cut, reported with the next `Dropped`.
    skipped: u64,
    ended: bool,
}

/// The single-consumer queue between a reader task and the sender.
#[derive(Default)]
pub struct Queue {
    state: Mutex<State>,
    notify: Notify,
}

impl Queue {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Offer one unit; cuts the backlog when full.
    pub fn push(&self, unit: Unit) {
        {
            let mut s = self.lock();
            if s.skip_to_key {
                if !unit.key() {
                    s.skipped += 1;
                    return;
                }
                s.skip_to_key = false;
                if s.skipped > 0 {
                    let n = std::mem::take(&mut s.skipped);
                    s.queue.push_back(SourceEvent::Dropped(n));
                }
            }
            let queued = s
                .queue
                .iter()
                .filter(|e| matches!(e, SourceEvent::Unit(_)))
                .count();
            if queued >= BACKLOG {
                let cut = queued as u64;
                s.queue.retain(|e| !matches!(e, SourceEvent::Unit(_)));
                s.queue.push_back(SourceEvent::Dropped(cut));
                if unit.key() {
                    s.queue.push_back(SourceEvent::Unit(unit));
                } else {
                    s.skip_to_key = true;
                    s.skipped = 1;
                }
            } else {
                s.queue.push_back(SourceEvent::Unit(unit));
            }
        }
        self.notify.notify_one();
    }

    pub fn end(&self, reason: Option<String>) {
        {
            let mut s = self.lock();
            if s.ended {
                return;
            }
            s.ended = true;
            s.queue.push_back(SourceEvent::End(reason));
        }
        self.notify.notify_one();
    }

    pub fn try_pop(&self) -> Option<SourceEvent> {
        self.lock().queue.pop_front()
    }

    /// The next event; waits for one.
    pub async fn pop(&self) -> SourceEvent {
        loop {
            if let Some(e) = self.try_pop() {
                return e;
            }
            self.notify.notified().await;
        }
    }
}

/// Sender → source: the publisher wants a keyframe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Keyframe,
}

pub struct Source {
    pub queue: Arc<Queue>,
    control: mpsc::UnboundedSender<Control>,
}

impl Source {
    /// Ask for a keyframe. A file replay starts on its first request (when the peer connects);
    /// the socket has no back channel, so the caller relays the `keyframe-request` line instead.
    pub fn request_keyframe(&self) {
        let _ = self.control.send(Control::Keyframe);
    }
}

#[derive(Debug, Clone)]
pub enum Spec {
    Socket(PathBuf),
    File {
        path: PathBuf,
        fps: f64,
        looped: bool,
    },
}

pub fn start(spec: Spec) -> Source {
    let queue = Arc::new(Queue::default());
    let (control, control_rx) = mpsc::unbounded_channel();
    match spec {
        Spec::Socket(path) => {
            tokio::spawn(read_socket(path, queue.clone(), control_rx));
        }
        Spec::File { path, fps, looped } => {
            tokio::spawn(replay_file(path, fps, looped, queue.clone(), control_rx));
        }
    }
    Source { queue, control }
}

/// How long to keep retrying a socket that is not there yet (the helper may still be starting).
const CONNECT_FOR: Duration = Duration::from_secs(5);

async fn connect(path: &Path) -> std::io::Result<tokio::net::UnixStream> {
    let deadline = tokio::time::Instant::now() + CONNECT_FOR;
    loop {
        match tokio::net::UnixStream::connect(path).await {
            Ok(s) => return Ok(s),
            Err(e) if tokio::time::Instant::now() >= deadline => return Err(e),
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

async fn read_socket(
    path: PathBuf,
    queue: Arc<Queue>,
    mut control: mpsc::UnboundedReceiver<Control>,
) {
    tokio::spawn(async move { while control.recv().await.is_some() {} });
    let mut stream = match connect(&path).await {
        Ok(s) => s,
        Err(e) => {
            queue.end(Some(format!("cannot connect to {}: {e}", path.display())));
            return;
        }
    };
    let mut reader = FrameReader::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) => {
                queue.end(Some("the stream socket closed".to_owned()));
                return;
            }
            Ok(n) => match reader.push(&buf[..n]) {
                Ok(units) => units.into_iter().for_each(|u| queue.push(u)),
                Err(e) => {
                    queue.end(Some(e.to_string()));
                    return;
                }
            },
            Err(e) => {
                queue.end(Some(format!("stream socket read: {e}")));
                return;
            }
        }
    }
}

/// A file's units: Annex-B is split into access units with pts at `fps`; framed files keep theirs.
pub fn load_units(bytes: &[u8], fps: f64) -> Result<Vec<Unit>, String> {
    if framing::looks_like_annexb(bytes) {
        let frame_us = 1_000_000.0 / fps;
        Ok(framing::split_access_units(bytes)
            .into_iter()
            .enumerate()
            .map(|(i, (flags, data))| Unit {
                flags,
                pts_us: (i as f64 * frame_us).round() as u64,
                data,
            })
            .collect())
    } else {
        let mut reader = FrameReader::new();
        let units = reader.push(bytes).map_err(|e| e.to_string())?;
        if reader.pending() > 0 {
            return Err(format!(
                "{} trailing bytes after the last unit",
                reader.pending()
            ));
        }
        Ok(units)
    }
}

async fn replay_file(
    path: PathBuf,
    fps: f64,
    looped: bool,
    queue: Arc<Queue>,
    mut control: mpsc::UnboundedReceiver<Control>,
) {
    let units = match tokio::fs::read(&path).await {
        Ok(bytes) => match load_units(&bytes, fps) {
            Ok(units) if !units.is_empty() => units,
            Ok(_) => {
                queue.end(Some(format!("{} holds no access units", path.display())));
                return;
            }
            Err(e) => {
                queue.end(Some(format!("{}: {e}", path.display())));
                return;
            }
        },
        Err(e) => {
            queue.end(Some(format!("cannot read {}: {e}", path.display())));
            return;
        }
    };
    // Replay starts on the first keyframe request: the peer has connected and wants a picture.
    if control.recv().await.is_none() {
        return;
    }
    tokio::spawn(async move { while control.recv().await.is_some() {} });
    let frame = Duration::from_secs_f64(1.0 / fps);
    let span_us = units.last().map_or(0, |u| u.pts_us) + frame.as_micros() as u64;
    let start = tokio::time::Instant::now();
    let mut n: u64 = 0;
    let mut lap: u64 = 0;
    loop {
        for unit in &units {
            tokio::time::sleep_until(start + frame.mul_f64(n as f64)).await;
            let mut unit = unit.clone();
            unit.pts_us += lap * span_us;
            queue.push(unit);
            n += 1;
        }
        if !looped {
            queue.end(None);
            return;
        }
        lap += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::FLAG_KEY;

    fn unit(key: bool, pts_us: u64) -> Unit {
        Unit {
            flags: if key { FLAG_KEY } else { 0 },
            pts_us,
            data: vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }],
        }
    }

    fn drain(q: &Queue) -> Vec<SourceEvent> {
        std::iter::from_fn(|| q.try_pop()).collect()
    }

    #[test]
    fn passes_units_through_while_the_sender_keeps_up() {
        let q = Queue::default();
        q.push(unit(true, 0));
        q.push(unit(false, 1));
        assert_eq!(
            drain(&q),
            vec![
                SourceEvent::Unit(unit(true, 0)),
                SourceEvent::Unit(unit(false, 1))
            ]
        );
    }

    #[test]
    fn a_full_backlog_is_cut_and_deltas_skipped_until_a_keyframe() {
        let q = Queue::default();
        for i in 0..BACKLOG as u64 {
            q.push(unit(i == 0, i));
        }
        q.push(unit(false, 10));
        q.push(unit(false, 11));
        q.push(unit(true, 12));
        q.push(unit(false, 13));
        assert_eq!(
            drain(&q),
            vec![
                SourceEvent::Dropped(BACKLOG as u64),
                SourceEvent::Dropped(2),
                SourceEvent::Unit(unit(true, 12)),
                SourceEvent::Unit(unit(false, 13)),
            ]
        );
    }

    #[test]
    fn a_keyframe_arriving_at_a_full_backlog_is_kept() {
        let q = Queue::default();
        for i in 0..BACKLOG as u64 {
            q.push(unit(false, i));
        }
        q.push(unit(true, 9));
        q.push(unit(false, 10));
        assert_eq!(
            drain(&q),
            vec![
                SourceEvent::Dropped(BACKLOG as u64),
                SourceEvent::Unit(unit(true, 9)),
                SourceEvent::Unit(unit(false, 10)),
            ]
        );
    }

    #[test]
    fn end_is_reported_once_after_the_queued_units() {
        let q = Queue::default();
        q.push(unit(true, 0));
        q.end(None);
        q.end(Some("again".into()));
        assert_eq!(
            drain(&q),
            vec![SourceEvent::Unit(unit(true, 0)), SourceEvent::End(None)]
        );
    }

    #[test]
    fn loads_an_annexb_file_with_pts_at_the_frame_rate() {
        let units = load_units(include_bytes!("../tests/fixtures/fixture.h264"), 60.0).unwrap();
        assert_eq!(units.len(), 120);
        assert!(units[0].key());
        assert_eq!(units[1].pts_us, 16_667);
        assert_eq!(units[60].pts_us, 1_000_000);
    }

    #[test]
    fn loads_a_framed_file_with_its_own_pts_and_rejects_a_torn_tail() {
        let a = unit(true, 5);
        let b = unit(false, 99);
        let mut bytes = framing::frame(&a);
        bytes.extend(framing::frame(&b));
        assert_eq!(load_units(&bytes, 60.0).unwrap(), vec![a, b]);
        bytes.pop();
        assert!(load_units(&bytes, 60.0).is_err());
    }

    #[tokio::test]
    async fn a_socket_source_reads_units_split_across_writes() {
        use tokio::io::AsyncWriteExt;
        let dir = std::env::temp_dir().join(format!("wstream-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.sock");
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let src = start(Spec::Socket(path.clone()));
        let (mut conn, _) = listener.accept().await.unwrap();
        let bytes: Vec<u8> = [unit(true, 0), unit(false, 16_667)]
            .iter()
            .flat_map(framing::frame)
            .collect();
        for chunk in bytes.chunks(7) {
            conn.write_all(chunk).await.unwrap();
            conn.flush().await.unwrap();
        }
        drop(conn);
        let mut got = Vec::new();
        loop {
            let e = src.queue.pop().await;
            let end = matches!(e, SourceEvent::End(_));
            got.push(e);
            if end {
                break;
            }
        }
        assert_eq!(got[0], SourceEvent::Unit(unit(true, 0)));
        assert_eq!(got[1], SourceEvent::Unit(unit(false, 16_667)));
        assert!(matches!(&got[2], SourceEvent::End(Some(r)) if r.contains("closed")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_missing_socket_ends_with_an_error() {
        tokio::time::pause();
        let src = start(Spec::Socket(PathBuf::from("/nonexistent/wstream.sock")));
        let e = src.queue.pop().await;
        assert!(matches!(e, SourceEvent::End(Some(r)) if r.contains("cannot connect")));
    }

    #[tokio::test]
    async fn a_file_replay_waits_for_the_first_keyframe_request() {
        tokio::time::pause();
        let dir = std::env::temp_dir().join(format!("wstream-f-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.h264");
        std::fs::write(&path, include_bytes!("../tests/fixtures/fixture.h264")).unwrap();
        let src = start(Spec::File {
            path,
            fps: 60.0,
            looped: false,
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            src.queue.try_pop().is_none(),
            "nothing before the peer connects"
        );
        src.request_keyframe();
        let mut units = 0;
        loop {
            match src.queue.pop().await {
                SourceEvent::Unit(u) => {
                    assert_eq!(u.key(), units == 0);
                    units += 1;
                }
                SourceEvent::End(None) => break,
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(units, 120);
        let _ = std::fs::remove_dir_all(dir);
    }
}
