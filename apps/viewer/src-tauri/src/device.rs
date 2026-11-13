//! Commands that talk to warden-api with the bearer token held in the calling window's session.
//!
//! The webview makes no network requests: it calls these commands and gets data or a
//! `{code, message}` error back. Every command resolves its session by the calling window's label,
//! so one host process serves many device windows.

use crate::registry::{Registry, Viewer};
use crate::session::{Credentials, Event, Scope, ViewerInfo};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const SDP: &str = "application/sdp";

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        let unreachable = e.is_connect() || e.is_timeout();
        network_error(unreachable, &e.without_url().to_string())
    }
}

/// A connect or timeout failure reads as "unreachable"; anything else keeps its own text.
fn network_error(unreachable: bool, message: &str) -> ApiError {
    if unreachable {
        ApiError::new("UNREACHABLE", "can't reach warden cloud; retrying")
    } else {
        ApiError::new("NETWORK", message)
    }
}

type CmdResult<T> = Result<T, ApiError>;

/// The calling window's viewer, or `NO_SESSION` when the window has none (closing, or unknown).
pub(crate) fn viewer_for(registry: &Registry, label: &str) -> CmdResult<Arc<Viewer>> {
    registry
        .get(label)
        .ok_or_else(|| ApiError::new("NO_SESSION", "this window has no session"))
}

fn trim_slash(s: &str) -> &str {
    s.trim_end_matches('/')
}

/// `scheme://host[:port]` of a URL, or None when it is not absolute.
fn origin(url: &str) -> Option<&str> {
    let after_scheme = url.find("://")? + 3;
    let end = url[after_scheme..]
        .find('/')
        .map_or(url.len(), |i| after_scheme + i);
    Some(&url[..end])
}

/// Resolve the `Location` of a WHEP resource against the API. A relative path is joined; an
/// absolute URL is accepted only on the API's own origin, so the bearer never leaves it.
pub fn resolve_location(api_url: &str, location: &str) -> Result<String, ApiError> {
    if location.starts_with("//") {
        return Err(ApiError::new(
            "BAD_LOCATION",
            "protocol-relative Location refused",
        ));
    }
    if location.starts_with('/') {
        return Ok(format!("{}{}", trim_slash(api_url), location));
    }
    match (origin(location), origin(api_url)) {
        (Some(a), Some(b)) if a == b => Ok(location.to_string()),
        (Some(_), _) => Err(ApiError::new(
            "BAD_LOCATION",
            "Location is on a different origin",
        )),
        _ => Ok(format!("{}/{}", trim_slash(api_url), location)),
    }
}

pub(crate) fn device_url(c: &Credentials, tail: &str) -> String {
    format!(
        "{}/v1/devices/{}{}",
        trim_slash(&c.api_url),
        c.device_id,
        tail
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SwipeDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinchScale {
    ZoomIn,
    ZoomOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DeviceKey {
    Enter,
    Backspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenUnits {
    Points,
    Pixels,
}

/// `GET /screen`: the size input coordinates are in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceScreen {
    pub width: f64,
    pub height: f64,
    pub units: ScreenUnits,
}

/// One drive verb: its path under `/v1/devices/:id` and its JSON body.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceAction {
    Tap {
        x: i64,
        y: i64,
    },
    DoubleTap {
        x: i64,
        y: i64,
    },
    LongPress {
        x: i64,
        y: i64,
        duration_ms: Option<u32>,
    },
    Swipe {
        x: i64,
        y: i64,
        direction: SwipeDirection,
        duration_ms: Option<u32>,
    },
    Drag {
        from_x: i64,
        from_y: i64,
        to_x: i64,
        to_y: i64,
        duration_ms: Option<u32>,
    },
    Pinch {
        x: i64,
        y: i64,
        scale: PinchScale,
    },
    Key {
        key: DeviceKey,
    },
    GoHome,
    Shake,
    SetLocation {
        latitude: f64,
        longitude: f64,
    },
}

impl DeviceAction {
    pub fn path(&self) -> &'static str {
        match self {
            Self::Tap { .. } => "/tap",
            Self::DoubleTap { .. } => "/double-tap",
            Self::LongPress { .. } => "/long-press",
            Self::Swipe { .. } => "/swipe",
            Self::Drag { .. } => "/drag",
            Self::Pinch { .. } => "/pinch",
            Self::Key { .. } => "/key",
            Self::GoHome => "/go-home",
            Self::Shake => "/shake",
            Self::SetLocation { .. } => "/set-location",
        }
    }

    /// Bodyless verbs send `{}`; `durationMs` is omitted when not given.
    pub fn body(&self) -> serde_json::Value {
        use serde_json::json;
        let mut body = match self {
            Self::Tap { x, y } | Self::DoubleTap { x, y } | Self::LongPress { x, y, .. } => {
                json!({ "x": x, "y": y })
            }
            Self::Swipe {
                x, y, direction, ..
            } => {
                json!({ "x": x, "y": y, "direction": direction })
            }
            Self::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
                ..
            } => {
                json!({ "fromX": from_x, "fromY": from_y, "toX": to_x, "toY": to_y })
            }
            Self::Pinch { x, y, scale } => json!({ "x": x, "y": y, "scale": scale }),
            Self::Key { key } => json!({ "key": key }),
            Self::GoHome | Self::Shake => json!({}),
            Self::SetLocation {
                latitude,
                longitude,
            } => {
                json!({ "latitude": latitude, "longitude": longitude })
            }
        };
        if let Self::LongPress {
            duration_ms: Some(ms),
            ..
        }
        | Self::Swipe {
            duration_ms: Some(ms),
            ..
        }
        | Self::Drag {
            duration_ms: Some(ms),
            ..
        } = self
        {
            body["durationMs"] = (*ms).into();
        }
        body
    }
}

pub(crate) fn require_drive(c: &Credentials) -> CmdResult<()> {
    if c.scope == Scope::Drive {
        Ok(())
    } else {
        Err(ApiError::new("SCOPE", "this viewer is read-only"))
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
    code: Option<String>,
}

/// Map a non-2xx status and body to `{code, message}`: 401 means the token expired, otherwise
/// warden-api's `{success:false,error,code}` wins over the bare status.
fn error_for_status(status: u16, body: &str) -> ApiError {
    if status == 401 {
        return ApiError::new("EXPIRED", "access expired, run warden view again");
    }
    match serde_json::from_str::<ErrorBody>(body) {
        Ok(ErrorBody {
            error: Some(message),
            code,
        }) => ApiError::new(&code.unwrap_or_else(|| format!("HTTP_{status}")), message),
        _ => ApiError::new(
            &format!("HTTP_{status}"),
            format!("request failed ({status})"),
        ),
    }
}

async fn failure(response: reqwest::Response) -> ApiError {
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    error_for_status(status, &text)
}

pub(crate) async fn ok_or_failure(response: reqwest::Response) -> CmdResult<reqwest::Response> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(failure(response).await)
    }
}

async fn post_json(
    client: &reqwest::Client,
    c: &Credentials,
    tail: &str,
    body: serde_json::Value,
) -> CmdResult<()> {
    let response = client
        .post(device_url(c, tail))
        .bearer_auth(&c.token)
        .json(&body)
        .send()
        .await?;
    let status = response.status().as_u16();
    let result = ok_or_failure(response).await;
    match &result {
        Ok(_) => log::info!("device {tail}: {status}"),
        Err(e) => log::warn!("device {tail}: {status} {}", e.code),
    }
    result?;
    Ok(())
}

#[tauri::command]
pub fn viewer_info(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<ViewerInfo> {
    Ok(viewer_for(&registry, window.label())?.session.info())
}

/// One `GET /v1/devices/:id` with the viewer token: the status code and body, for `billing`.
pub async fn fetch_device(
    client: &reqwest::Client,
    c: &Credentials,
) -> Result<(u16, String), reqwest::Error> {
    let response = client
        .get(device_url(c, ""))
        .bearer_auth(&c.token)
        .send()
        .await?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok((status, body))
}

/// Close from the window's prompt: `release` = Shut down, otherwise Keep running. Attached, the
/// choice goes to this window's CLI (it stops the device and ends the lease). Detached, no CLI is
/// listening, so Shut down stops the device here with the window's `drive` viewer token (the
/// lease stays until `warden release` or gc, showing `stop_reason: user`). A failed stop keeps the
/// window open. Only this window closes; the host keeps the others (its `Destroyed` handler ends
/// the relay).
#[tauri::command]
pub async fn close_viewer(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
    release: bool,
) -> CmdResult<()> {
    let viewer = viewer_for(&registry, window.label())?;
    if !viewer.session.detached() {
        viewer.send(&Event::Close { release });
    } else if release {
        let c = viewer.session.credentials();
        require_drive(&c)?;
        stop_device(registry.client(), &c).await?;
    }
    window
        .destroy()
        .map_err(|e| ApiError::new("WINDOW", e.to_string()))
}

/// `DELETE /v1/devices/:id` with the viewer token. `stopped: false` (Revyl still releasing) is fine:
/// the stop is under way and the server finishes it.
async fn stop_device(client: &reqwest::Client, c: &Credentials) -> CmdResult<()> {
    let response = client
        .delete(device_url(c, ""))
        .bearer_auth(&c.token)
        .send()
        .await?;
    let status = response.status().as_u16();
    let result = ok_or_failure(response).await;
    match &result {
        Ok(_) => log::info!("device stop: {status}"),
        Err(e) => log::warn!("device stop: {status} {}", e.code),
    }
    result.map(|_| ())
}

/// Open the launch-time billing URL in the system browser. Takes no argument: JS cannot choose
/// where this goes.
#[tauri::command]
pub fn open_billing(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    let Some(url) = viewer_for(&registry, window.label())?.session.billing_url() else {
        return Err(ApiError::new(
            "NO_BILLING_URL",
            "no billing URL was provided",
        ));
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| ApiError::new("OPEN", e.to_string()))
}

#[derive(Serialize)]
pub struct WhepAnswer {
    pub sdp: String,
}

#[tauri::command]
pub async fn whep_offer(
    sdp: String,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<WhepAnswer> {
    let sdp = post_offer(&registry, window.label(), sdp).await?;
    Ok(WhepAnswer { sdp })
}

/// POST an SDP offer to the device's WHEP endpoint, keep the `Location` resource on the window's
/// viewer and return the SDP answer. Shared by the webview and the native stream paths.
pub async fn post_offer(registry: &Registry, label: &str, sdp: String) -> CmdResult<String> {
    let viewer = viewer_for(registry, label)?;
    let c = viewer.session.credentials();
    let response = registry
        .client()
        .post(device_url(&c, "/stream"))
        .bearer_auth(&c.token)
        .header("content-type", SDP)
        .body(sdp)
        .send()
        .await?;
    let response = ok_or_failure(response).await?;
    let location = response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::new("NO_LOCATION", "stream response had no Location"))?;
    let resource = resolve_location(&c.api_url, &location)?;
    let answer = response.text().await?;
    viewer.set_resource(Some(resource));
    Ok(answer)
}

/// One STUN/TURN server from `GET /stream`'s additive `iceServers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Deserialize)]
struct StreamInfo {
    #[serde(default, rename = "iceServers")]
    ice_servers: Option<Vec<IceServer>>,
}

/// The ICE servers in a `GET /stream` body; empty when absent or unparseable.
pub fn parse_ice_servers(body: &str) -> Vec<IceServer> {
    serde_json::from_str::<StreamInfo>(body)
        .ok()
        .and_then(|info| info.ice_servers)
        .unwrap_or_default()
}

/// `GET /v1/devices/:id/stream` for this window. Best effort: an older API, or any failure, gives
/// no servers and the stream keeps its host-candidate-only behaviour.
pub async fn fetch_ice_servers(registry: &Registry, label: &str) -> Vec<IceServer> {
    let Ok(viewer) = viewer_for(registry, label) else {
        return Vec::new();
    };
    let c = viewer.session.credentials();
    let response = registry
        .client()
        .get(device_url(&c, "/stream"))
        .bearer_auth(&c.token)
        .send()
        .await;
    match response {
        Ok(r) if r.status().is_success() => parse_ice_servers(&r.text().await.unwrap_or_default()),
        Ok(r) => {
            log::info!("ice servers: GET /stream {}", r.status().as_u16());
            Vec::new()
        }
        Err(e) => {
            log::warn!("ice servers: {}", e.without_url());
            Vec::new()
        }
    }
}

/// The ICE servers for the webview's own RTCPeerConnection.
#[tauri::command]
pub async fn stream_ice_servers(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<Vec<IceServer>> {
    Ok(fetch_ice_servers(&registry, window.label()).await)
}

/// DELETE a WHEP resource. Best effort: the server expires it on its own, so a failure is logged.
pub async fn delete_resource(client: &reqwest::Client, c: &Credentials, resource: String) {
    if let Err(e) = client.delete(resource).bearer_auth(&c.token).send().await {
        log::warn!("whep close failed: {}", e.without_url());
    }
}

/// Tear the stream down. Best effort: a missing resource is not an error, and a failed DELETE is
/// logged because the server expires the resource on its own.
#[tauri::command]
pub async fn whep_close(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    close_resource(&registry, window.label()).await
}

/// DELETE the window's WHEP resource, if it has one.
pub async fn close_resource(registry: &Registry, label: &str) -> CmdResult<()> {
    let viewer = viewer_for(registry, label)?;
    let c = viewer.session.credentials();
    if let Some(resource) = viewer.take_resource() {
        delete_resource(registry.client(), &c, resource).await;
    }
    Ok(())
}

/// Run one drive verb for the calling window: resolve its session, refuse `view` scope, POST.
async fn drive(
    window: &tauri::WebviewWindow,
    registry: &Registry,
    action: DeviceAction,
) -> CmdResult<()> {
    let viewer = viewer_for(registry, window.label())?;
    let c = viewer.session.credentials();
    require_drive(&c)?;
    post_json(registry.client(), &c, action.path(), action.body()).await
}

#[tauri::command]
pub async fn tap(
    x: i64,
    y: i64,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(&window, &registry, DeviceAction::Tap { x, y }).await
}

#[tauri::command]
pub async fn double_tap(
    x: i64,
    y: i64,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(&window, &registry, DeviceAction::DoubleTap { x, y }).await
}

#[tauri::command]
pub async fn long_press(
    x: i64,
    y: i64,
    duration_ms: Option<u32>,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(
        &window,
        &registry,
        DeviceAction::LongPress { x, y, duration_ms },
    )
    .await
}

#[tauri::command]
pub async fn swipe(
    x: i64,
    y: i64,
    direction: SwipeDirection,
    duration_ms: Option<u32>,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(
        &window,
        &registry,
        DeviceAction::Swipe {
            x,
            y,
            direction,
            duration_ms,
        },
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn drag(
    from_x: i64,
    from_y: i64,
    to_x: i64,
    to_y: i64,
    duration_ms: Option<u32>,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(
        &window,
        &registry,
        DeviceAction::Drag {
            from_x,
            from_y,
            to_x,
            to_y,
            duration_ms,
        },
    )
    .await
}

#[tauri::command]
pub async fn pinch(
    x: i64,
    y: i64,
    scale: PinchScale,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(&window, &registry, DeviceAction::Pinch { x, y, scale }).await
}

#[tauri::command]
pub async fn key(
    key: DeviceKey,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(&window, &registry, DeviceAction::Key { key }).await
}

#[tauri::command]
pub async fn go_home(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(&window, &registry, DeviceAction::GoHome).await
}

#[tauri::command]
pub async fn shake(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(&window, &registry, DeviceAction::Shake).await
}

#[tauri::command]
pub async fn set_location(
    latitude: f64,
    longitude: f64,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    drive(
        &window,
        &registry,
        DeviceAction::SetLocation {
            latitude,
            longitude,
        },
    )
    .await
}

/// The device screen size and its unit, which input coordinates are in. View scope may read it.
#[tauri::command]
pub async fn device_screen(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<DeviceScreen> {
    let viewer = viewer_for(&registry, window.label())?;
    let c = viewer.session.credentials();
    let response = registry
        .client()
        .get(device_url(&c, "/screen"))
        .bearer_auth(&c.token)
        .send()
        .await?;
    let text = ok_or_failure(response).await?.text().await?;
    serde_json::from_str(&text).map_err(|e| ApiError::new("BAD_RESPONSE", e.to_string()))
}

#[tauri::command]
pub async fn input(
    text: String,
    clear_first: Option<bool>,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    let viewer = viewer_for(&registry, window.label())?;
    let c = viewer.session.credentials();
    require_drive(&c)?;
    let mut body = serde_json::json!({ "text": text });
    if let Some(clear) = clear_first {
        body["clearFirst"] = clear.into();
    }
    post_json(registry.client(), &c, "/input", body).await
}

#[tauri::command]
pub async fn open_url(
    url: String,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    let viewer = viewer_for(&registry, window.label())?;
    let c = viewer.session.credentials();
    require_drive(&c)?;
    post_json(
        registry.client(),
        &c,
        "/open-url",
        serde_json::json!({ "url": url }),
    )
    .await
}

/// Write on the blocking pool so a slow disk never holds a runtime worker (the native stream
/// shares it).
async fn write_file(path: std::path::PathBuf, bytes: Vec<u8>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(path, bytes))
        .await
        .map_err(|e| ApiError::new("WRITE", e.to_string()))?
        .map_err(|e| ApiError::new("WRITE", e.to_string()))
}

/// Fetch a PNG, ask where to save it, write it. Returns the path, or None when the panel was
/// cancelled.
#[tauri::command]
pub async fn screenshot(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<Option<String>> {
    let viewer = viewer_for(&registry, window.label())?;
    let c = viewer.session.credentials();
    let response = registry
        .client()
        .get(device_url(&c, "/screenshot"))
        .bearer_auth(&c.token)
        .send()
        .await?;
    let bytes = ok_or_failure(response).await?.bytes().await?;
    let name = format!("{}-screenshot.png", c.device_id);
    let (picked_tx, picked_rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("PNG image", &["png"])
        .set_file_name(name)
        .save_file(move |picked| {
            let _ = picked_tx.send(picked);
        });
    let Ok(Some(path)) = picked_rx.await else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| ApiError::new("BAD_PATH", e.to_string()))?;
    write_file(path.clone(), bytes.to_vec()).await?;
    Ok(Some(path.display().to_string()))
}

/// JS calls this when the first frame plays. The event goes to this window's sink, once per session.
#[tauri::command]
pub fn viewer_streaming(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
) -> CmdResult<()> {
    viewer_for(&registry, window.label())?.announce_streaming();
    Ok(())
}

/// Resize the window so the video area has the device's aspect ratio. `chrome_height` is the
/// logical height of everything around the video (bar and insets) and `pad_x` the horizontal
/// insets. The video area keeps its long edge, so a rotation swaps the screen around the window's
/// centre, shrunk to 90% of the monitor when larger. Later user resizes hold this ratio.
#[tauri::command]
pub fn fit_window(
    aspect: f64,
    chrome_height: f64,
    pad_x: f64,
    window: tauri::WebviewWindow,
) -> CmdResult<()> {
    if !(aspect.is_finite() && aspect > 0.0) {
        return Err(ApiError::new("BAD_ASPECT", "aspect must be positive"));
    }
    let werr = |e: tauri::Error| ApiError::new("WINDOW", e.to_string());
    let scale = window.scale_factor().map_err(werr)?;
    let inner = window.inner_size().map_err(werr)?.to_logical::<f64>(scale);
    let lock = crate::aspect::Lock {
        aspect,
        chrome_height,
        pad_x,
    };
    let monitor = window.current_monitor().ok().flatten();
    let bound = monitor.as_ref().map(|m| {
        let size = m.size().to_logical::<f64>(scale);
        (size.width * 0.9, size.height * 0.9)
    });
    let (width, height) = crate::aspect::fit(&lock, (inner.width, inner.height), bound);
    let (min_w, min_h) = crate::aspect::min_size(aspect);
    lock_aspect(&window, lock);
    window
        .set_min_size(Some(tauri::LogicalSize::new(min_w, min_h)))
        .map_err(werr)?;
    let position = window
        .outer_position()
        .map_err(werr)?
        .to_logical::<f64>(scale);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(werr)?;
    let mut x = position.x + (inner.width - width) / 2.0;
    let mut y = position.y + (inner.height - height) / 2.0;
    if let Some(m) = monitor {
        let origin = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        x = x.clamp(origin.x, (origin.x + size.width - width).max(origin.x));
        y = y.clamp(origin.y, (origin.y + size.height - height).max(origin.y));
    }
    window
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(werr)?;
    Ok(())
}

/// Keep later user resizes at this ratio (see `aspect.rs`). Best effort: a failure only means
/// the window resizes freely, so it is logged, never returned.
fn lock_aspect(window: &tauri::WebviewWindow, lock: crate::aspect::Lock) {
    #[cfg(target_os = "macos")]
    let native = window.ns_window().map(|p| p as usize);
    #[cfg(windows)]
    let native = window.hwnd().map(|h| h.0 as usize);
    #[cfg(not(any(target_os = "macos", windows)))]
    let native: Result<usize, tauri::Error> = Err(tauri::Error::WindowNotFound);
    let native = match native {
        Ok(native) => native,
        Err(e) => {
            log::warn!("aspect: no native window handle: {e}");
            return;
        }
    };
    crate::aspect::set(native, window.label(), lock);
    let install = move || {
        #[cfg(target_os = "macos")]
        crate::aspect_macos::install(native);
        #[cfg(windows)]
        crate::aspect_windows::install(native);
    };
    if let Err(e) = window.run_on_main_thread(install) {
        log::warn!("aspect: could not install the resize hook: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_file_writes_off_the_runtime_workers() {
        let path =
            std::env::temp_dir().join(format!("warden-viewer-write-{}.bin", std::process::id()));
        write_file(path.clone(), vec![1, 2, 3]).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![1, 2, 3]);
        let _ = std::fs::remove_file(&path);
        let missing = std::env::temp_dir().join("warden-viewer-no-such-dir/x.bin");
        assert_eq!(write_file(missing, vec![]).await.unwrap_err().code, "WRITE");
    }

    #[test]
    fn parses_ice_servers_from_the_stream_info() {
        let body = r#"{"iceServers":[{"urls":["stun:s:3478"]},{"urls":["turn:t:3478"],"username":"u","credential":"c"}]}"#;
        assert_eq!(
            parse_ice_servers(body),
            vec![
                IceServer {
                    urls: vec!["stun:s:3478".into()],
                    username: None,
                    credential: None
                },
                IceServer {
                    urls: vec!["turn:t:3478".into()],
                    username: Some("u".into()),
                    credential: Some("c".into())
                },
            ]
        );
        assert!(parse_ice_servers(r#"{"status":"live"}"#).is_empty());
        assert!(parse_ice_servers("nope").is_empty());
    }

    #[test]
    fn action_paths_and_bodies_match_the_api_contract() {
        use serde_json::json;
        let cases: Vec<(DeviceAction, &str, serde_json::Value)> = vec![
            (
                DeviceAction::Tap { x: 1, y: 2 },
                "/tap",
                json!({"x":1,"y":2}),
            ),
            (
                DeviceAction::DoubleTap { x: 1, y: 2 },
                "/double-tap",
                json!({"x":1,"y":2}),
            ),
            (
                DeviceAction::LongPress {
                    x: 1,
                    y: 2,
                    duration_ms: None,
                },
                "/long-press",
                json!({"x":1,"y":2}),
            ),
            (
                DeviceAction::LongPress {
                    x: 1,
                    y: 2,
                    duration_ms: Some(800),
                },
                "/long-press",
                json!({"x":1,"y":2,"durationMs":800}),
            ),
            (
                DeviceAction::Swipe {
                    x: 5,
                    y: 6,
                    direction: SwipeDirection::Up,
                    duration_ms: Some(300),
                },
                "/swipe",
                json!({"x":5,"y":6,"direction":"up","durationMs":300}),
            ),
            (
                DeviceAction::Drag {
                    from_x: 1,
                    from_y: 2,
                    to_x: 3,
                    to_y: 4,
                    duration_ms: None,
                },
                "/drag",
                json!({"fromX":1,"fromY":2,"toX":3,"toY":4}),
            ),
            (
                DeviceAction::Drag {
                    from_x: 1,
                    from_y: 2,
                    to_x: 3,
                    to_y: 4,
                    duration_ms: Some(50),
                },
                "/drag",
                json!({"fromX":1,"fromY":2,"toX":3,"toY":4,"durationMs":50}),
            ),
            (
                DeviceAction::Pinch {
                    x: 9,
                    y: 8,
                    scale: PinchScale::ZoomOut,
                },
                "/pinch",
                json!({"x":9,"y":8,"scale":"zoom_out"}),
            ),
            (
                DeviceAction::Key {
                    key: DeviceKey::Enter,
                },
                "/key",
                json!({"key":"ENTER"}),
            ),
            (
                DeviceAction::Key {
                    key: DeviceKey::Backspace,
                },
                "/key",
                json!({"key":"BACKSPACE"}),
            ),
            (DeviceAction::GoHome, "/go-home", json!({})),
            (DeviceAction::Shake, "/shake", json!({})),
            (
                DeviceAction::SetLocation {
                    latitude: -36.85,
                    longitude: 174.76,
                },
                "/set-location",
                json!({"latitude":-36.85,"longitude":174.76}),
            ),
        ];
        for (action, path, body) in cases {
            assert_eq!(action.path(), path);
            assert_eq!(action.body(), body, "{path}");
        }
    }

    #[test]
    fn enums_reject_unknown_values_from_the_webview() {
        assert!(serde_json::from_str::<SwipeDirection>("\"diagonal\"").is_err());
        assert!(serde_json::from_str::<PinchScale>("\"zoom_in\"").is_ok());
        assert!(serde_json::from_str::<PinchScale>("\"big\"").is_err());
        assert!(serde_json::from_str::<DeviceKey>("\"ENTER\"").is_ok());
        assert!(serde_json::from_str::<DeviceKey>("\"enter\"").is_err());
    }

    #[test]
    fn parses_the_screen_response() {
        let screen: DeviceScreen =
            serde_json::from_str(r#"{"width":393,"height":852,"units":"points"}"#).unwrap();
        assert_eq!(
            screen,
            DeviceScreen {
                width: 393.0,
                height: 852.0,
                units: ScreenUnits::Points
            }
        );
    }

    #[test]
    fn joins_a_relative_location() {
        assert_eq!(
            resolve_location(
                "https://api.warden.co.nz",
                "/v1/devices/d1/stream/resource/abc"
            )
            .unwrap(),
            "https://api.warden.co.nz/v1/devices/d1/stream/resource/abc"
        );
    }

    #[test]
    fn tolerates_a_trailing_slash_on_the_api_url() {
        assert_eq!(
            resolve_location("http://127.0.0.1:9/", "/v1/x").unwrap(),
            "http://127.0.0.1:9/v1/x"
        );
    }

    #[test]
    fn accepts_an_absolute_location_on_the_same_origin() {
        assert_eq!(
            resolve_location(
                "https://api.warden.co.nz",
                "https://api.warden.co.nz/v1/r/1"
            )
            .unwrap(),
            "https://api.warden.co.nz/v1/r/1"
        );
    }

    #[test]
    fn refuses_other_origins_so_the_bearer_stays_home() {
        let err = resolve_location("https://api.warden.co.nz", "https://evil.example/v1/r/1")
            .unwrap_err();
        assert_eq!(err.code, "BAD_LOCATION");
        let err = resolve_location("https://api.warden.co.nz", "//evil.example/x").unwrap_err();
        assert_eq!(err.code, "BAD_LOCATION");
    }

    #[test]
    fn origin_requires_a_scheme() {
        assert_eq!(origin("https://a.b:8080/x/y"), Some("https://a.b:8080"));
        assert_eq!(origin("https://a.b"), Some("https://a.b"));
        assert_eq!(origin("/x"), None);
    }

    #[test]
    fn a_window_without_a_session_gets_no_session() {
        let reg = Registry::new();
        let e = viewer_for(&reg, "dev-d1").err().unwrap();
        assert_eq!(e.code, "NO_SESSION");
        reg.insert(Arc::new(Viewer::new(
            "dev-d1",
            crate::registry::testing::session("d1", "wvt_a"),
            Arc::new(crate::registry::testing::RecordingSink::default()),
        )));
        assert!(viewer_for(&reg, "dev-d1").is_ok());
        assert_eq!(viewer_for(&reg, "dev-d2").err().unwrap().code, "NO_SESSION");
    }

    #[test]
    fn view_scope_cannot_drive() {
        let mut c = Credentials {
            api_url: "x".into(),
            device_id: "d".into(),
            token: "t".into(),
            scope: Scope::View,
        };
        assert_eq!(require_drive(&c).unwrap_err().code, "SCOPE");
        c.scope = Scope::Drive;
        assert!(require_drive(&c).is_ok());
    }

    #[test]
    fn builds_device_urls() {
        let c = Credentials {
            api_url: "https://api.warden.co.nz/".into(),
            device_id: "d1".into(),
            token: "t".into(),
            scope: Scope::Drive,
        };
        assert_eq!(
            device_url(&c, "/tap"),
            "https://api.warden.co.nz/v1/devices/d1/tap"
        );
    }

    #[test]
    fn connect_and_timeout_errors_read_as_unreachable() {
        let e = network_error(true, "error sending request");
        assert_eq!(e.code, "UNREACHABLE");
        assert_eq!(e.message, "can't reach warden cloud; retrying");
        assert_eq!(network_error(false, "bad body").code, "NETWORK");
    }

    #[test]
    fn a_401_means_the_token_expired() {
        let e = error_for_status(
            401,
            r#"{"success":false,"error":"nope","code":"UNAUTHORIZED"}"#,
        );
        assert_eq!(e.code, "EXPIRED");
        assert_eq!(e.message, "access expired, run warden view again");
    }

    #[test]
    fn other_statuses_prefer_the_server_error_body() {
        let e = error_for_status(
            403,
            r#"{"success":false,"error":"read-only","code":"SCOPE"}"#,
        );
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("SCOPE", "read-only")
        );
        let e = error_for_status(502, "<html>");
        assert_eq!(e.code, "HTTP_502");
    }

    #[test]
    fn api_errors_serialise_as_code_and_message() {
        let json = serde_json::to_string(&ApiError::new("SCOPE", "no")).unwrap();
        assert_eq!(json, r#"{"code":"SCOPE","message":"no"}"#);
    }
}
