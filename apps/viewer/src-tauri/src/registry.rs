//! Every open device window, keyed by its webview label: the session, the WHEP resource and where
//! the window's process-contract events (`ready`, `streaming`, `error`) go.
//!
//! One host process holds many of these. Nothing here is global per process any more: commands
//! resolve their `Viewer` by the calling window's label.

use crate::session::{Credentials, Event, Session, SessionState};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// Where one window's contract events go: stdout of a single-window process, or its relay.
pub trait EventSink: Send + Sync {
    fn event(&self, event: &Event);
}

/// The single-window sink: JSON lines on this process's stdout.
pub struct StdoutSink;

impl EventSink for StdoutSink {
    fn event(&self, event: &Event) {
        crate::session::emit(event);
    }
}

/// The webview label for a device: `dev-<deviceId>`, with anything outside Tauri's label alphabet
/// (`a-zA-Z0-9-/:_`) mapped to `_`.
pub fn label_for(device_id: &str) -> String {
    let safe: String = device_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("dev-{safe}")
}

/// What a takeover leaves behind for the caller to clean up.
pub struct Takeover {
    /// The sink of the session that was replaced (its relay is told `closed: superseded`).
    pub old_sink: Arc<dyn EventSink>,
    /// The replaced session's credentials, to DELETE `old_resource` with.
    pub old_credentials: Credentials,
    /// The WHEP resource the window was playing, if any.
    pub old_resource: Option<String>,
}

pub struct Viewer {
    label: String,
    pub session: SessionState,
    resource: Mutex<Option<String>>,
    streaming_announced: AtomicBool,
    sink: RwLock<Arc<dyn EventSink>>,
    /// Bumped on takeover and close. A watcher thread holds the generation it started under and
    /// stops once it is stale.
    generation: AtomicU64,
    closed: AtomicBool,
}

impl Viewer {
    pub fn new(label: impl Into<String>, session: Session, sink: Arc<dyn EventSink>) -> Self {
        Self {
            label: label.into(),
            session: SessionState::new(session),
            resource: Mutex::new(None),
            streaming_announced: AtomicBool::new(false),
            sink: RwLock::new(sink),
            generation: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn set_resource(&self, resource: Option<String>) {
        *self.resource.lock().unwrap_or_else(|e| e.into_inner()) = resource;
    }

    pub fn resource(&self) -> Option<String> {
        self.resource
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn take_resource(&self) -> Option<String> {
        self.resource
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    pub fn sink(&self) -> Arc<dyn EventSink> {
        self.sink.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Send a contract event to this window's sink only.
    pub fn send(&self, event: &Event) {
        self.sink().event(event);
    }

    /// The first frame played: tell the sink once per session. Returns whether it was sent.
    pub fn announce_streaming(&self) -> bool {
        let first = !self.streaming_announced.swap(true, Ordering::SeqCst);
        if first {
            self.send(&Event::Streaming);
        }
        first
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// True while the window is open and no takeover happened since `generation`.
    pub fn is_current(&self, generation: u64) -> bool {
        !self.closed.load(Ordering::SeqCst) && self.generation() == generation
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// The same device was opened again: swap in the new session and sink, drop the stream
    /// resource and the `streaming` latch, and stale every watcher.
    pub fn take_over(&self, session: Session, sink: Arc<dyn EventSink>) -> Takeover {
        let old_credentials = self.session.credentials();
        self.session.replace(session);
        let old_sink = std::mem::replace(
            &mut *self.sink.write().unwrap_or_else(|e| e.into_inner()),
            sink,
        );
        self.streaming_announced.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        Takeover {
            old_sink,
            old_credentials,
            old_resource: self.take_resource(),
        }
    }

    /// The window is gone: every watcher stops.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// Every open window plus the one HTTP client they share.
pub struct Registry {
    client: reqwest::Client,
    viewers: RwLock<HashMap<String, Arc<Viewer>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("http client"),
            viewers: RwLock::new(HashMap::new()),
        }
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn get(&self, label: &str) -> Option<Arc<Viewer>> {
        self.viewers
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .cloned()
    }

    /// Add a window's viewer. Returns the one it replaced under the same label, if any.
    pub fn insert(&self, viewer: Arc<Viewer>) -> Option<Arc<Viewer>> {
        self.viewers
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(viewer.label().to_string(), viewer)
    }

    /// Drop a window's viewer and stop its watchers.
    pub fn remove(&self, label: &str) -> Option<Arc<Viewer>> {
        let removed = self
            .viewers
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        if let Some(v) = &removed {
            v.close();
        }
        removed
    }

    pub fn len(&self) -> usize {
        self.viewers.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;

    /// Records every event sent to it.
    #[derive(Default)]
    pub struct RecordingSink(pub Mutex<Vec<String>>);

    impl EventSink for RecordingSink {
        fn event(&self, event: &Event) {
            self.0
                .lock()
                .unwrap()
                .push(crate::session::event_line(event));
        }
    }

    impl RecordingSink {
        pub fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    pub fn session(device_id: &str, token: &str) -> Session {
        crate::session::parse_session(&format!(
            r#"{{"apiUrl":"https://api.warden.co.nz","deviceId":"{device_id}","token":"{token}","expiresAt":"2030-01-01T00:00:00Z","scope":"drive","title":"{device_id} · warden","platform":"ios"}}"#
        ))
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::session::parse_refresh;

    fn viewer(device_id: &str, token: &str) -> (Arc<Viewer>, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink::default());
        let v = Arc::new(Viewer::new(
            label_for(device_id),
            session(device_id, token),
            sink.clone(),
        ));
        (v, sink)
    }

    #[test]
    fn labels_are_per_device_and_tauri_safe() {
        assert_eq!(
            label_for("e56b29e1-e5ac-4e68-9aa8-644e8e7444d7"),
            "dev-e56b29e1-e5ac-4e68-9aa8-644e8e7444d7"
        );
        assert_eq!(label_for("a b/c.d"), "dev-a_b_c_d");
    }

    #[test]
    fn two_sessions_are_isolated() {
        let reg = Registry::new();
        let (a, _) = viewer("d1", "wvt_a");
        let (b, _) = viewer("d2", "wvt_b");
        reg.insert(a);
        reg.insert(b);
        assert_eq!(reg.len(), 2);
        assert_eq!(
            reg.get("dev-d1").unwrap().session.credentials().token,
            "wvt_a"
        );
        assert_eq!(
            reg.get("dev-d2").unwrap().session.credentials().token,
            "wvt_b"
        );
        reg.get("dev-d1")
            .unwrap()
            .set_resource(Some("https://api/r/1".into()));
        assert_eq!(reg.get("dev-d2").unwrap().resource(), None);
        assert!(reg.get("dev-nope").is_none());
    }

    #[test]
    fn a_refresh_hits_only_its_own_label() {
        let reg = Registry::new();
        let (a, _) = viewer("d1", "wvt_a");
        let (b, _) = viewer("d2", "wvt_b");
        reg.insert(a);
        reg.insert(b);
        reg.get("dev-d1").unwrap().session.apply_refresh(
            parse_refresh(r#"{"token":"wvt_a2","expiresAt":"2031-01-01T00:00:00Z"}"#).unwrap(),
        );
        assert_eq!(
            reg.get("dev-d1").unwrap().session.credentials().token,
            "wvt_a2"
        );
        assert_eq!(
            reg.get("dev-d2").unwrap().session.credentials().token,
            "wvt_b"
        );
        assert_eq!(
            reg.get("dev-d2").unwrap().session.expires_at(),
            "2030-01-01T00:00:00Z"
        );
    }

    #[test]
    fn events_reach_only_their_own_sink_and_streaming_goes_once() {
        let (a, sink_a) = viewer("d1", "wvt_a");
        let (b, sink_b) = viewer("d2", "wvt_b");
        a.send(&Event::Ready);
        assert!(a.announce_streaming());
        assert!(!a.announce_streaming());
        b.send(&Event::Ready);
        assert_eq!(
            sink_a.lines(),
            vec![r#"{"event":"ready"}"#, r#"{"event":"streaming"}"#]
        );
        assert_eq!(sink_b.lines(), vec![r#"{"event":"ready"}"#]);
    }

    #[test]
    fn takeover_swaps_session_and_sink_and_stales_watchers() {
        let (a, old_sink) = viewer("d1", "wvt_a");
        a.set_resource(Some("https://api/r/1".into()));
        a.announce_streaming();
        let gen = a.generation();
        let new_sink = Arc::new(RecordingSink::default());
        let t = a.take_over(session("d1", "wvt_new"), new_sink.clone());
        assert_eq!(t.old_credentials.token, "wvt_a");
        assert_eq!(t.old_resource.as_deref(), Some("https://api/r/1"));
        assert_eq!(a.resource(), None);
        assert_eq!(a.session.credentials().token, "wvt_new");
        assert!(!a.is_current(gen));
        assert!(a.is_current(a.generation()));
        assert!(a.announce_streaming());
        assert_eq!(old_sink.lines(), vec![r#"{"event":"streaming"}"#]);
        assert_eq!(new_sink.lines(), vec![r#"{"event":"streaming"}"#]);
        t.old_sink.event(&Event::Ready);
        assert_eq!(old_sink.lines().len(), 2);
    }

    #[test]
    fn remove_closes_and_stops_watchers() {
        let reg = Registry::new();
        let (a, _) = viewer("d1", "wvt_a");
        let gen = a.generation();
        reg.insert(a.clone());
        assert!(a.is_current(gen));
        assert!(reg.remove("dev-d1").is_some());
        assert!(a.is_closed());
        assert!(!a.is_current(gen));
        assert!(reg.is_empty());
        assert!(reg.remove("dev-d1").is_none());
    }
}
