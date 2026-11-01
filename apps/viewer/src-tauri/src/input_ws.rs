//! The live input socket: one WebSocket per window to `{api}/v1/devices/:id/input`, carrying touch
//! and key frames to the device and acks back. The URL is built from the session's own API origin
//! and the bearer goes in the upgrade request header only, so it never leaves that origin.

use crate::device::{device_url, require_drive, viewer_for, ApiError, DeviceKey};
use crate::registry::Registry;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

type CmdResult<T> = Result<T, ApiError>;

const KEEPALIVE: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Down,
    Move,
    Up,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TouchGesture {
    Tap,
    Drag,
    LongPress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinchGesture {
    ZoomIn,
    ZoomOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Touch {
    pub id: i64,
    pub x: f64,
    pub y: f64,
}

/// A client frame. `id` is client-generated and echoed in the server's acks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputFrame {
    #[serde(rename_all = "camelCase")]
    Touch {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        phase: Phase,
        x: i64,
        y: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gesture: Option<TouchGesture>,
    },
    #[serde(rename_all = "camelCase")]
    MultiTouch {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        phase: Phase,
        touches: Vec<Touch>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gesture: Option<PinchGesture>,
    },
    GoHome {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Shake {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Orientation {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        orientation: Orientation,
    },
    OpenUrl {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        url: String,
    },
    Location {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        latitude: f64,
        longitude: f64,
    },
    #[serde(rename_all = "camelCase")]
    Input {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        clear_first: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        paste: Option<bool>,
    },
    Key {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        key: DeviceKey,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AckStatus {
    Received,
    Done,
}

/// A server frame, forwarded to the webview. `Closed` is also synthesised when the socket drops.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    Ready,
    Ack {
        id: String,
        status: AckStatus,
    },
    Error {
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Closed {
        reason: String,
    },
}

/// `http(s)://api/v1/devices/:id/input` as `ws(s)://...`; None for any other scheme.
pub fn ws_url(http_url: &str) -> Option<String> {
    if let Some(rest) = http_url.strip_prefix("https://") {
        Some(format!("wss://{rest}"))
    } else {
        http_url
            .strip_prefix("http://")
            .map(|rest| format!("ws://{rest}"))
    }
}

struct Connection {
    generation: u64,
    outbox: mpsc::UnboundedSender<Message>,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// The live input socket of each window, by label.
#[derive(Default)]
pub struct InputSockets {
    next: AtomicU64,
    conns: Mutex<HashMap<String, Connection>>,
}

impl InputSockets {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Connection>> {
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn insert(&self, label: &str, conn: Connection) {
        if let Some(old) = self.lock().insert(label.to_owned(), conn) {
            old.task.abort();
        }
    }

    fn remove(&self, label: &str) -> Option<Connection> {
        self.lock().remove(label)
    }

    fn remove_generation(&self, label: &str, generation: u64) {
        let mut conns = self.lock();
        if conns.get(label).is_some_and(|c| c.generation == generation) {
            conns.remove(label);
        }
    }
}

fn parse_event(text: &str) -> Option<InputEvent> {
    serde_json::from_str(text).ok()
}

async fn run(
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
    channel: Channel<InputEvent>,
    mut outbox: mpsc::UnboundedReceiver<Message>,
) -> String {
    let (socket, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(ok) => ok,
        Err(e) => return format!("connect failed: {e}"),
    };
    let (mut sink, mut stream) = socket.split();
    let mut ping = tokio::time::interval(KEEPALIVE);
    ping.tick().await;
    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if let Some(event) = parse_event(text.as_str()) {
                        let closed = matches!(event, InputEvent::Closed { .. });
                        let _ = channel.send(event);
                        if closed {
                            return "server closed".into();
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None => return "socket closed".into(),
                Some(Ok(_)) => {}
                Some(Err(e)) => return format!("socket error: {e}"),
            },
            outgoing = outbox.recv() => match outgoing {
                Some(message) => {
                    if let Err(e) = sink.send(message).await {
                        return format!("send failed: {e}");
                    }
                }
                None => return "closed".into(),
            },
            _ = ping.tick() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    return "ping failed".into();
                }
            }
        }
    }
}

/// Open (or reopen) this window's input socket. Server frames arrive on `channel`, then a
/// `{type:"closed"}` when it drops. Drive scope only.
#[tauri::command]
pub async fn input_connect(
    channel: Channel<InputEvent>,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
    sockets: State<'_, Arc<InputSockets>>,
) -> CmdResult<()> {
    let label = window.label().to_owned();
    let viewer = viewer_for(&registry, &label)?;
    let c = viewer.session.credentials();
    require_drive(&c)?;
    let url = ws_url(&device_url(&c, "/input"))
        .ok_or_else(|| ApiError::new("BAD_URL", "api url is not http(s)"))?;
    let mut request = url
        .into_client_request()
        .map_err(|e| ApiError::new("BAD_URL", e.to_string()))?;
    let bearer = HeaderValue::from_str(&format!("Bearer {}", c.token))
        .map_err(|_| ApiError::new("BAD_TOKEN", "token is not a valid header"))?;
    request.headers_mut().insert("authorization", bearer);

    let generation = sockets.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::unbounded_channel();
    let owner = sockets.inner().clone();
    let task_label = label.clone();
    let task = tauri::async_runtime::spawn(async move {
        let reason = run(request, channel.clone(), rx).await;
        log::info!("input socket ended: {reason}");
        owner.remove_generation(&task_label, generation);
        let _ = channel.send(InputEvent::Closed { reason });
    });
    sockets.insert(
        &label,
        Connection {
            generation,
            outbox: tx,
            task,
        },
    );
    Ok(())
}

/// Send one frame on this window's socket.
#[tauri::command]
pub fn input_send(
    frame: InputFrame,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
    sockets: State<'_, Arc<InputSockets>>,
) -> CmdResult<()> {
    let viewer = viewer_for(&registry, window.label())?;
    require_drive(&viewer.session.credentials())?;
    let text =
        serde_json::to_string(&frame).map_err(|e| ApiError::new("BAD_FRAME", e.to_string()))?;
    let conns = sockets.lock();
    let conn = conns
        .get(window.label())
        .ok_or_else(|| ApiError::new("NO_INPUT", "input socket is not connected"))?;
    conn.outbox
        .send(Message::text(text))
        .map_err(|_| ApiError::new("NO_INPUT", "input socket is closed"))
}

/// Close this window's input socket.
#[tauri::command]
pub fn input_close(window: tauri::WebviewWindow, sockets: State<'_, Arc<InputSockets>>) {
    if let Some(conn) = sockets.remove(window.label()) {
        let _ = conn.outbox.send(Message::Close(None));
        conn.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn to_json(frame: &InputFrame) -> serde_json::Value {
        serde_json::to_value(frame).unwrap()
    }

    #[test]
    fn builds_ws_urls_from_the_api_scheme() {
        assert_eq!(
            ws_url("https://api.warden.co.nz/v1/devices/d/input").unwrap(),
            "wss://api.warden.co.nz/v1/devices/d/input"
        );
        assert_eq!(
            ws_url("http://127.0.0.1:3000/v1/devices/d/input").unwrap(),
            "ws://127.0.0.1:3000/v1/devices/d/input"
        );
        assert_eq!(ws_url("ftp://x/y"), None);
    }

    #[test]
    fn touch_frame_omits_absent_fields() {
        let down = InputFrame::Touch {
            id: None,
            phase: Phase::Down,
            x: 10,
            y: 20,
            duration_ms: None,
            gesture: None,
        };
        assert_eq!(
            to_json(&down),
            json!({"type":"touch","phase":"down","x":10,"y":20})
        );
        let up = InputFrame::Touch {
            id: Some("a1".into()),
            phase: Phase::Up,
            x: 10,
            y: 20,
            duration_ms: Some(120),
            gesture: Some(TouchGesture::LongPress),
        };
        assert_eq!(
            to_json(&up),
            json!({"type":"touch","id":"a1","phase":"up","x":10,"y":20,"durationMs":120,"gesture":"long_press"})
        );
    }

    #[test]
    fn multi_touch_and_simple_frames() {
        let pinch = InputFrame::MultiTouch {
            id: None,
            phase: Phase::Move,
            touches: vec![
                Touch {
                    id: 0,
                    x: 1.0,
                    y: 2.0,
                },
                Touch {
                    id: 1,
                    x: 3.0,
                    y: 4.0,
                },
            ],
            gesture: Some(PinchGesture::ZoomIn),
        };
        assert_eq!(
            to_json(&pinch),
            json!({"type":"multiTouch","phase":"move","touches":[{"id":0,"x":1.0,"y":2.0},{"id":1,"x":3.0,"y":4.0}],"gesture":"zoom_in"})
        );
        assert_eq!(
            to_json(&InputFrame::GoHome { id: None }),
            json!({"type":"goHome"})
        );
        assert_eq!(
            to_json(&InputFrame::Shake { id: None }),
            json!({"type":"shake"})
        );
        assert_eq!(
            to_json(&InputFrame::Orientation {
                id: None,
                orientation: Orientation::Landscape
            }),
            json!({"type":"orientation","orientation":"landscape"})
        );
        assert_eq!(
            to_json(&InputFrame::Location {
                id: None,
                latitude: -36.8,
                longitude: 174.7
            }),
            json!({"type":"location","latitude":-36.8,"longitude":174.7})
        );
        assert_eq!(
            to_json(&InputFrame::Input {
                id: None,
                text: "hi".into(),
                clear_first: Some(true),
                paste: Some(false)
            }),
            json!({"type":"input","text":"hi","clearFirst":true,"paste":false})
        );
        assert_eq!(
            to_json(&InputFrame::Key {
                id: None,
                key: DeviceKey::Backspace
            }),
            json!({"type":"key","key":"BACKSPACE"})
        );
        assert_eq!(
            to_json(&InputFrame::OpenUrl {
                id: None,
                url: "https://x.y".into()
            }),
            json!({"type":"openUrl","url":"https://x.y"})
        );
    }

    #[test]
    fn frames_round_trip_from_the_webview_and_reject_bad_values() {
        let parsed: InputFrame =
            serde_json::from_value(json!({"type":"touch","phase":"move","x":1,"y":2})).unwrap();
        assert_eq!(
            parsed,
            InputFrame::Touch {
                id: None,
                phase: Phase::Move,
                x: 1,
                y: 2,
                duration_ms: None,
                gesture: None
            }
        );
        assert!(serde_json::from_value::<InputFrame>(
            json!({"type":"touch","phase":"hover","x":1,"y":2})
        )
        .is_err());
        assert!(serde_json::from_value::<InputFrame>(json!({"type":"bogus"})).is_err());
        assert!(serde_json::from_value::<InputFrame>(json!({"type":"key","key":"TAB"})).is_err());
    }

    #[test]
    fn parses_server_events() {
        assert_eq!(parse_event(r#"{"type":"ready"}"#), Some(InputEvent::Ready));
        assert_eq!(
            parse_event(r#"{"type":"ack","id":"a","status":"done"}"#),
            Some(InputEvent::Ack {
                id: "a".into(),
                status: AckStatus::Done
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"error","code":"OUT_OF_BOUNDS","message":"m","id":"a"}"#),
            Some(InputEvent::Error {
                code: "OUT_OF_BOUNDS".into(),
                message: "m".into(),
                id: Some("a".into())
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"error","code":"X","message":"m"}"#),
            Some(InputEvent::Error {
                code: "X".into(),
                message: "m".into(),
                id: None
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"closed","reason":"idle"}"#),
            Some(InputEvent::Closed {
                reason: "idle".into()
            })
        );
        assert_eq!(parse_event("not json"), None);
        assert_eq!(parse_event(r#"{"type":"mystery"}"#), None);
    }

    #[test]
    fn events_serialise_for_the_webview() {
        assert_eq!(
            serde_json::to_value(InputEvent::Closed { reason: "x".into() }).unwrap(),
            json!({"type":"closed","reason":"x"})
        );
    }
}
