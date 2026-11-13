//! The single viewer host: one process, one window per device, many relays.
//!
//! Each relay connection carries one CLI's session. `Host::serve` turns its frames into window
//! operations through `WindowOps`, which is Tauri in the app and a recorder in tests.

use crate::ipc::{self, CloseReason, Conn, ToHost, ToRelay};
use crate::registry::{label_for, EventSink, Registry, Viewer};
use crate::session::{self, Event};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// What the host needs from the windowing layer.
pub trait WindowOps: Send + Sync + 'static {
    /// Build the window for a new viewer and start its watchers.
    fn create(&self, viewer: &Arc<Viewer>) -> Result<(), String>;
    /// The same device was opened again: retitle, reload, focus, restart watchers.
    fn take_over(&self, viewer: &Arc<Viewer>);
    /// Close a window the host decided to close (EOF or dropped relay).
    fn close(&self, label: &str);
    /// The host is done: unlink the endpoint and exit the process.
    fn exit(&self);
}

/// A relay's half of the contract: `ready`/`streaming`/`error` frames and the final `closed`.
pub struct RelaySink {
    tx: mpsc::UnboundedSender<ToRelay>,
}

impl EventSink for RelaySink {
    fn event(&self, event: &Event) {
        let frame = match event {
            Event::Ready => ToRelay::Ready,
            Event::Streaming => ToRelay::Streaming,
            Event::Close { release } => ToRelay::Close { release: *release },
            Event::Error { message } => ToRelay::Error {
                message: (*message).to_string(),
            },
        };
        let _ = self.tx.send(frame);
    }

    fn closed(&self, reason: CloseReason) {
        let _ = self.tx.send(ToRelay::Closed { reason });
    }
}

pub struct Host<W: WindowOps> {
    windows: W,
    registry: Arc<Registry>,
    connections: AtomicUsize,
    exiting: AtomicBool,
    grace: Duration,
}

/// True when `sink` is the one `viewer` currently reports to: this relay still owns the window.
fn owns(viewer: &Viewer, sink: &Arc<dyn EventSink>) -> bool {
    Arc::ptr_eq(&viewer.sink(), sink)
}

impl<W: WindowOps> Host<W> {
    pub fn new(windows: W, registry: Arc<Registry>, grace: Duration) -> Self {
        Self {
            windows,
            registry,
            connections: AtomicUsize::new(0),
            exiting: AtomicBool::new(false),
            grace,
        }
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }

    /// Exit after `grace` when no window is open and no relay is connected. A racing `open` inside
    /// the grace keeps the host alive.
    pub fn exit_when_idle(self: &Arc<Self>, grace: Duration) {
        let host = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            if host.registry.is_empty()
                && host.connections.load(Ordering::SeqCst) == 0
                && !host.exiting.swap(true, Ordering::SeqCst)
            {
                log::info!("no windows and no relays left; exiting");
                host.windows.exit();
            }
        });
    }

    /// The user closed a window (or the host destroyed it): tell its relay, drop the session.
    pub fn on_window_closed(self: &Arc<Self>, label: &str) {
        if let Some(viewer) = self.registry.remove(label) {
            viewer.sink().closed(CloseReason::Window);
        }
        self.exit_when_idle(self.grace);
    }

    /// Serve one relay until it ends.
    pub async fn serve(self: Arc<Self>, conn: Conn) {
        self.connections.fetch_add(1, Ordering::SeqCst);
        let Conn { mut reader, writer } = conn;
        let (tx, rx) = mpsc::unbounded_channel();
        let writer_task = tokio::spawn(write_frames(writer, rx));
        let sink: Arc<dyn EventSink> = Arc::new(RelaySink { tx: tx.clone() });

        if let Some(viewer) = self.open(&mut reader, &sink, &tx).await {
            self.pump(&mut reader, &viewer, &sink).await;
        }

        drop(sink);
        drop(tx);
        let _ = writer_task.await;
        self.connections.fetch_sub(1, Ordering::SeqCst);
        self.exit_when_idle(self.grace);
    }

    /// Handle the first frame. Returns the viewer this relay now owns, or None when it ended.
    async fn open<R: tokio::io::AsyncBufRead + Unpin>(
        &self,
        reader: &mut R,
        sink: &Arc<dyn EventSink>,
        tx: &mpsc::UnboundedSender<ToRelay>,
    ) -> Option<Arc<Viewer>> {
        let refuse = |message: String| {
            let _ = tx.send(ToRelay::Error { message });
            None
        };
        let line = match ipc::read_frame::<_, ToHost>(reader).await {
            Ok(Some(ToHost::Open { proto, line })) if proto == ipc::PROTO => line,
            Ok(Some(ToHost::Open { proto, .. })) => {
                return refuse(format!(
                    "viewer protocol {proto} is not {}; reinstall the viewer",
                    ipc::PROTO
                ))
            }
            Ok(Some(_)) => return refuse("expected an open frame first".into()),
            Ok(None) => return None,
            Err(e) => return refuse(format!("bad open frame: {e}")),
        };
        if self.exiting.load(Ordering::SeqCst) {
            let _ = tx.send(ToRelay::Closed {
                reason: CloseReason::Shutdown,
            });
            return None;
        }
        let session = match session::parse_session(&line) {
            Ok(s) => s,
            Err(e) => return refuse(e.to_string()),
        };
        let label = label_for(&session.device_id);

        if let Some(viewer) = self.registry.get(&label) {
            let takeover = viewer.take_over(session, sink.clone());
            takeover.old_sink.closed(CloseReason::Superseded);
            if let Some(resource) = takeover.old_resource {
                let client = self.registry.client().clone();
                let creds = takeover.old_credentials;
                tokio::spawn(async move {
                    crate::device::delete_resource(&client, &creds, resource).await
                });
            }
            self.windows.take_over(&viewer);
            viewer.send(&Event::Ready);
            return Some(viewer);
        }

        let viewer = Arc::new(Viewer::new(label.clone(), session, sink.clone()));
        self.registry.insert(viewer.clone());
        match self.windows.create(&viewer) {
            Ok(()) => {
                viewer.send(&Event::Ready);
                Some(viewer)
            }
            Err(e) => {
                self.registry.remove(&label);
                refuse(format!("could not open the window: {e}"))
            }
        }
    }

    /// Apply refreshes until EOF or the relay drops, then close or detach.
    async fn pump<R: tokio::io::AsyncBufRead + Unpin>(
        &self,
        reader: &mut R,
        viewer: &Arc<Viewer>,
        sink: &Arc<dyn EventSink>,
    ) {
        let eof = loop {
            match ipc::read_frame::<_, ToHost>(reader).await {
                Ok(Some(ToHost::Refresh { line })) => {
                    if !owns(viewer, sink) {
                        continue;
                    }
                    match session::parse_refresh(&line) {
                        Ok(refresh) => viewer.session.apply_refresh(refresh),
                        Err(e) => log::warn!("ignoring refresh for {}: {e}", viewer.label()),
                    }
                }
                Ok(Some(ToHost::Eof)) => break true,
                Ok(Some(ToHost::Open { .. })) => {
                    log::warn!("ignoring a second open frame on one relay")
                }
                Ok(None) => break false,
                Err(e) => {
                    log::warn!("relay for {} dropped: {e}", viewer.label());
                    break false;
                }
            }
        };
        if !owns(viewer, sink) || viewer.is_closed() {
            return;
        }
        match session::eof_action(viewer.session.detached()) {
            session::EofAction::HoldUntilExpiry => sink.closed(CloseReason::Detached),
            session::EofAction::Exit => {
                self.registry.remove(viewer.label());
                if eof {
                    sink.closed(CloseReason::Eof);
                }
                self.windows.close(viewer.label());
            }
        }
    }
}

/// Drain the relay's frames onto the socket. Ends after `closed`/`error` or when every sender is gone.
async fn write_frames(
    mut writer: Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
    mut rx: mpsc::UnboundedReceiver<ToRelay>,
) {
    while let Some(frame) = rx.recv().await {
        let last = matches!(frame, ToRelay::Closed { .. } | ToRelay::Error { .. });
        if ipc::write_frame(&mut writer, &frame).await.is_err() || last {
            break;
        }
    }
    let _ = tokio::io::AsyncWriteExt::shutdown(&mut writer).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::{relay, StdinMsg};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        created: Mutex<Vec<String>>,
        taken_over: Mutex<Vec<String>>,
        closed: Mutex<Vec<String>>,
        exited: AtomicBool,
    }

    #[derive(Clone, Default)]
    struct FakeWindows(Arc<Recorder>);

    impl WindowOps for FakeWindows {
        fn create(&self, viewer: &Arc<Viewer>) -> Result<(), String> {
            self.0
                .created
                .lock()
                .unwrap()
                .push(viewer.label().to_string());
            Ok(())
        }
        fn take_over(&self, viewer: &Arc<Viewer>) {
            self.0
                .taken_over
                .lock()
                .unwrap()
                .push(viewer.label().to_string());
        }
        fn close(&self, label: &str) {
            self.0.closed.lock().unwrap().push(label.to_string());
        }
        fn exit(&self) {
            self.0.exited.store(true, Ordering::SeqCst);
        }
    }

    fn start_line(device_id: &str, token: &str, detached: bool) -> String {
        format!(
            r#"{{"apiUrl":"http://127.0.0.1:9","deviceId":"{device_id}","token":"{token}","expiresAt":"2030-01-01T00:00:00Z","scope":"drive","title":"{device_id} · warden","platform":"ios","detached":{detached}}}"#
        )
    }

    /// A relay wired to the host through an in-memory pipe. Returns its stdin, its exit code and
    /// its stdout lines once it ends.
    struct TestRelay {
        stdin: mpsc::UnboundedSender<StdinMsg>,
        done: tokio::task::JoinHandle<(i32, Vec<String>)>,
    }

    fn connect(host: &Arc<Host<FakeWindows>>, line: String) -> TestRelay {
        let (relay_side, host_side) = tokio::io::duplex(64 * 1024);
        let (hr, hw) = tokio::io::split(host_side);
        let (rr, rw) = tokio::io::split(relay_side);
        let host_conn = Conn {
            reader: tokio::io::BufReader::new(Box::new(hr)),
            writer: Box::new(hw),
        };
        let relay_conn = Conn {
            reader: tokio::io::BufReader::new(Box::new(rr)),
            writer: Box::new(rw),
        };
        tokio::spawn(host.clone().serve(host_conn));
        let (stdin, rx) = mpsc::unbounded_channel();
        let done = tokio::spawn(async move {
            let mut out = Vec::new();
            let code = relay(line, rx, relay_conn, &mut out).await;
            let lines = String::from_utf8(out)
                .unwrap()
                .lines()
                .map(str::to_owned)
                .collect();
            (code, lines)
        });
        TestRelay { stdin, done }
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    fn host() -> (Arc<Host<FakeWindows>>, Arc<Recorder>) {
        let windows = FakeWindows::default();
        let rec = windows.0.clone();
        let host = Arc::new(Host::new(
            windows,
            Arc::new(Registry::new()),
            Duration::from_millis(100),
        ));
        (host, rec)
    }

    #[tokio::test]
    async fn two_relays_get_two_windows_and_eof_closes_only_its_own() {
        let (host, rec) = host();
        let d1 = connect(&host, start_line("d1", "wvt_1", false));
        let d2 = connect(&host, start_line("d2", "wvt_2", false));
        settle().await;
        assert_eq!(rec.created.lock().unwrap().len(), 2);
        assert_eq!(host.registry().len(), 2);

        d1.stdin.send(StdinMsg::Eof).unwrap();
        let (code, out) = d1.done.await.unwrap();
        assert_eq!(code, 0);
        assert_eq!(out, vec![r#"{"event":"ready"}"#]);
        assert_eq!(*rec.closed.lock().unwrap(), vec!["dev-d1"]);
        assert!(host.registry().get("dev-d1").is_none());
        assert!(host.registry().get("dev-d2").is_some());
        assert!(!rec.exited.load(Ordering::SeqCst));

        drop(d2.stdin);
        let (code, _) = d2.done.await.unwrap();
        assert_eq!(code, 0);
        settle().await;
        assert_eq!(*rec.closed.lock().unwrap(), vec!["dev-d1", "dev-d2"]);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(rec.exited.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_dropped_relay_closes_its_attached_window() {
        let (host, rec) = host();
        let d1 = connect(&host, start_line("d1", "wvt_1", false));
        let d2 = connect(&host, start_line("d2", "wvt_2", false));
        settle().await;
        d2.done.abort();
        settle().await;
        assert_eq!(*rec.closed.lock().unwrap(), vec!["dev-d2"]);
        assert!(host.registry().get("dev-d1").is_some());
        drop(d1);
    }

    #[tokio::test]
    async fn refreshes_reach_only_their_own_session() {
        let (host, _) = host();
        let d1 = connect(&host, start_line("d1", "wvt_1", false));
        let _d2 = connect(&host, start_line("d2", "wvt_2", false));
        settle().await;
        d1.stdin
            .send(StdinMsg::Line(
                r#"{"token":"wvt_1b","expiresAt":"2031-01-01T00:00:00Z"}"#.into(),
            ))
            .unwrap();
        settle().await;
        let reg = host.registry();
        assert_eq!(
            reg.get("dev-d1").unwrap().session.credentials().token,
            "wvt_1b"
        );
        assert_eq!(
            reg.get("dev-d2").unwrap().session.credentials().token,
            "wvt_2"
        );
    }

    #[tokio::test]
    async fn detached_eof_keeps_the_window_and_the_relay_exits() {
        let (host, rec) = host();
        let d1 = connect(&host, start_line("d1", "wvt_1", true));
        d1.stdin.send(StdinMsg::Eof).unwrap();
        let (code, out) = d1.done.await.unwrap();
        assert_eq!(code, 0);
        assert_eq!(out, vec![r#"{"event":"ready"}"#]);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(rec.closed.lock().unwrap().is_empty());
        assert!(host.registry().get("dev-d1").is_some());
        assert!(!rec.exited.load(Ordering::SeqCst));

        host.on_window_closed("dev-d1");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(host.registry().is_empty());
        assert!(rec.exited.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn the_same_device_twice_supersedes_the_first_relay() {
        let (host, rec) = host();
        let first = connect(&host, start_line("d1", "wvt_old", false));
        settle().await;
        let second = connect(&host, start_line("d1", "wvt_new", false));
        let (code, out) = first.done.await.unwrap();
        assert_eq!(code, 0);
        assert_eq!(out, vec![r#"{"event":"ready"}"#]);
        assert_eq!(rec.created.lock().unwrap().len(), 1);
        assert_eq!(*rec.taken_over.lock().unwrap(), vec!["dev-d1"]);
        let viewer = host.registry().get("dev-d1").unwrap();
        assert_eq!(viewer.session.credentials().token, "wvt_new");
        assert!(rec.closed.lock().unwrap().is_empty());

        second.stdin.send(StdinMsg::Eof).unwrap();
        let (code, out) = second.done.await.unwrap();
        assert_eq!(code, 0);
        assert_eq!(out, vec![r#"{"event":"ready"}"#]);
        assert_eq!(*rec.closed.lock().unwrap(), vec!["dev-d1"]);
    }

    #[tokio::test]
    async fn the_user_closing_a_window_ends_its_relay() {
        let (host, _) = host();
        let d1 = connect(&host, start_line("d1", "wvt_1", false));
        settle().await;
        host.registry().get("dev-d1").unwrap().announce_streaming();
        host.on_window_closed("dev-d1");
        let (code, out) = d1.done.await.unwrap();
        assert_eq!(code, 0);
        assert_eq!(
            out,
            vec![r#"{"event":"ready"}"#, r#"{"event":"streaming"}"#]
        );
        drop(d1.stdin);
    }

    #[tokio::test]
    async fn the_close_prompt_choice_reaches_only_its_relay_before_closed() {
        let (host, _) = host();
        let d1 = connect(&host, start_line("d1", "wvt_1", false));
        let d2 = connect(&host, start_line("d2", "wvt_2", false));
        settle().await;
        host.registry()
            .get("dev-d1")
            .unwrap()
            .send(&Event::Close { release: true });
        host.on_window_closed("dev-d1");
        let (code, out) = d1.done.await.unwrap();
        assert_eq!(code, 0);
        assert_eq!(
            out,
            vec![
                r#"{"event":"ready"}"#,
                r#"{"event":"close","release":true}"#
            ]
        );
        assert!(host.registry().get("dev-d2").is_some());
        d2.stdin.send(StdinMsg::Eof).unwrap();
        let (_, out) = d2.done.await.unwrap();
        assert_eq!(out, vec![r#"{"event":"ready"}"#]);
    }

    #[tokio::test]
    async fn a_bad_session_line_fails_the_relay_with_exit_1() {
        let (host, rec) = host();
        let bad = start_line("d1", "", false);
        let d1 = connect(&host, bad);
        let (code, out) = d1.done.await.unwrap();
        assert_eq!(code, 1);
        assert_eq!(out.len(), 1);
        assert!(out[0].starts_with(r#"{"event":"error","message":"#));
        assert!(rec.created.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_token_never_reaches_relay_stdout() {
        let (host, _) = host();
        let d1 = connect(&host, start_line("d1", "wvt_secret", false));
        settle().await;
        d1.stdin.send(StdinMsg::Eof).unwrap();
        let (_, out) = d1.done.await.unwrap();
        assert!(out.iter().all(|l| !l.contains("wvt_secret")));
    }
}
