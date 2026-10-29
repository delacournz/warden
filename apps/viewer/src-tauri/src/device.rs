//! Commands that talk to warden-api with the bearer token held in `SessionState`.
//!
//! The webview makes no network requests: it calls these commands and gets data or a
//! `{code, message}` error back.

use crate::session::{emit, Credentials, Event, Scope, SessionState, ViewerInfo};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

const SDP: &str = "application/sdp";
const TRICKLE: &str = "application/trickle-ice-sdpfrag";

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        let code = if e.is_timeout() { "TIMEOUT" } else { "NETWORK" };
        Self::new(code, e.without_url().to_string())
    }
}

type CmdResult<T> = Result<T, ApiError>;

pub struct DeviceState {
    client: reqwest::Client,
    resource: Mutex<Option<String>>,
    streaming_announced: AtomicBool,
}

impl DeviceState {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("http client"),
            resource: Mutex::new(None),
            streaming_announced: AtomicBool::new(false),
        }
    }
}

impl Default for DeviceState {
    fn default() -> Self {
        Self::new()
    }
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

fn device_url(c: &Credentials, tail: &str) -> String {
    format!(
        "{}/v1/devices/{}{}",
        trim_slash(&c.api_url),
        c.device_id,
        tail
    )
}

fn require_drive(c: &Credentials) -> CmdResult<()> {
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

/// Map a non-2xx response to `{code, message}`, preferring warden-api's `{success:false,error,code}`.
async fn failure(response: reqwest::Response) -> ApiError {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    match serde_json::from_str::<ErrorBody>(&text) {
        Ok(ErrorBody {
            error: Some(message),
            code,
        }) => ApiError::new(
            &code.unwrap_or_else(|| format!("HTTP_{}", status.as_u16())),
            message,
        ),
        _ => ApiError::new(&format!("HTTP_{}", status.as_u16()), status.to_string()),
    }
}

async fn ok_or_failure(response: reqwest::Response) -> CmdResult<reqwest::Response> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(failure(response).await)
    }
}

async fn post_json(
    state: &DeviceState,
    c: &Credentials,
    tail: &str,
    body: serde_json::Value,
) -> CmdResult<()> {
    let response = state
        .client
        .post(device_url(c, tail))
        .bearer_auth(&c.token)
        .json(&body)
        .send()
        .await?;
    ok_or_failure(response).await?;
    Ok(())
}

#[tauri::command]
pub fn viewer_info(session: State<'_, SessionState>) -> ViewerInfo {
    session.info()
}

#[derive(Serialize)]
pub struct WhepAnswer {
    pub sdp: String,
}

#[tauri::command]
pub async fn whep_offer(
    sdp: String,
    session: State<'_, SessionState>,
    device: State<'_, DeviceState>,
) -> CmdResult<WhepAnswer> {
    let c = session.credentials();
    let response = device
        .client
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
    *device.resource.lock().unwrap_or_else(|e| e.into_inner()) = Some(resource);
    Ok(WhepAnswer { sdp: answer })
}

fn current_resource(device: &DeviceState) -> Option<String> {
    device
        .resource
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
pub async fn whep_candidate(
    fragment: String,
    session: State<'_, SessionState>,
    device: State<'_, DeviceState>,
) -> CmdResult<()> {
    let c = session.credentials();
    let Some(resource) = current_resource(&device) else {
        return Err(ApiError::new("NO_STREAM", "no stream resource yet"));
    };
    let response = device
        .client
        .patch(resource)
        .bearer_auth(&c.token)
        .header("content-type", TRICKLE)
        .body(fragment)
        .send()
        .await?;
    ok_or_failure(response).await?;
    Ok(())
}

/// Tear the stream down. Best effort: a missing resource is not an error, and a failed DELETE is
/// logged because the server expires the resource on its own.
#[tauri::command]
pub async fn whep_close(
    session: State<'_, SessionState>,
    device: State<'_, DeviceState>,
) -> CmdResult<()> {
    let c = session.credentials();
    let resource = device
        .resource
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(resource) = resource {
        if let Err(e) = device
            .client
            .delete(resource)
            .bearer_auth(&c.token)
            .send()
            .await
        {
            log::warn!("whep close failed: {}", e.without_url());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn tap(
    x: i64,
    y: i64,
    session: State<'_, SessionState>,
    device: State<'_, DeviceState>,
) -> CmdResult<()> {
    let c = session.credentials();
    require_drive(&c)?;
    post_json(&device, &c, "/tap", serde_json::json!({ "x": x, "y": y })).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn swipe(
    from_x: i64,
    from_y: i64,
    to_x: i64,
    to_y: i64,
    duration_ms: Option<u32>,
    session: State<'_, SessionState>,
    device: State<'_, DeviceState>,
) -> CmdResult<()> {
    let c = session.credentials();
    require_drive(&c)?;
    let mut body = serde_json::json!({
        "fromX": from_x, "fromY": from_y, "toX": to_x, "toY": to_y,
    });
    if let Some(ms) = duration_ms {
        body["durationMs"] = ms.into();
    }
    post_json(&device, &c, "/swipe", body).await
}

#[tauri::command]
pub async fn input(
    text: String,
    clear_first: Option<bool>,
    session: State<'_, SessionState>,
    device: State<'_, DeviceState>,
) -> CmdResult<()> {
    let c = session.credentials();
    require_drive(&c)?;
    let mut body = serde_json::json!({ "text": text });
    if let Some(clear) = clear_first {
        body["clearFirst"] = clear.into();
    }
    post_json(&device, &c, "/input", body).await
}

#[tauri::command]
pub async fn open_url(
    url: String,
    session: State<'_, SessionState>,
    device: State<'_, DeviceState>,
) -> CmdResult<()> {
    let c = session.credentials();
    require_drive(&c)?;
    post_json(&device, &c, "/open-url", serde_json::json!({ "url": url })).await
}

/// Fetch a PNG, ask where to save it, write it. Returns the path, or None when the panel was
/// cancelled.
#[tauri::command]
pub async fn screenshot(
    app: tauri::AppHandle,
    session: State<'_, SessionState>,
    device: State<'_, DeviceState>,
) -> CmdResult<Option<String>> {
    let c = session.credentials();
    let response = device
        .client
        .get(device_url(&c, "/screenshot"))
        .bearer_auth(&c.token)
        .send()
        .await?;
    let bytes = ok_or_failure(response).await?.bytes().await?;
    let name = format!("{}-screenshot.png", c.device_id);
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("PNG image", &["png"])
        .set_file_name(name)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| ApiError::new("BAD_PATH", e.to_string()))?;
    std::fs::write(&path, &bytes).map_err(|e| ApiError::new("WRITE", e.to_string()))?;
    Ok(Some(path.display().to_string()))
}

/// JS calls this when the first frame plays. The event goes out once per process.
#[tauri::command]
pub fn viewer_streaming(device: State<'_, DeviceState>) {
    if !device.streaming_announced.swap(true, Ordering::SeqCst) {
        emit(&Event::Streaming);
    }
}

/// Resize the window so the video area has the device's aspect ratio. `chrome_height` is the
/// toolbar's logical height; the window keeps its height and changes its width, shrinking both when
/// the result would not fit the monitor.
#[tauri::command]
pub fn fit_window(aspect: f64, chrome_height: f64, window: tauri::WebviewWindow) -> CmdResult<()> {
    if !(aspect.is_finite() && aspect > 0.0) {
        return Err(ApiError::new("BAD_ASPECT", "aspect must be positive"));
    }
    let scale = window
        .scale_factor()
        .map_err(|e| ApiError::new("WINDOW", e.to_string()))?;
    let inner = window
        .inner_size()
        .map_err(|e| ApiError::new("WINDOW", e.to_string()))?;
    let (mut width, mut height) = fit_size(aspect, chrome_height, inner.height as f64 / scale);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let m = monitor.size();
        let (max_w, max_h) = (m.width as f64 / scale * 0.9, m.height as f64 / scale * 0.9);
        if width > max_w || height > max_h {
            let shrink = (max_w / width).min(max_h / height);
            (width, height) = fit_size(aspect, chrome_height, height * shrink);
        }
    }
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| ApiError::new("WINDOW", e.to_string()))?;
    Ok(())
}

/// Window size (logical) that keeps `height` and gives the video area below `chrome_height` the
/// requested aspect ratio.
pub fn fit_size(aspect: f64, chrome_height: f64, height: f64) -> (f64, f64) {
    let video_height = (height - chrome_height).max(1.0);
    ((video_height * aspect).round(), height.round())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn fit_size_keeps_height_and_derives_width() {
        assert_eq!(fit_size(0.5, 40.0, 840.0), (400.0, 840.0));
    }

    #[test]
    fn api_errors_serialise_as_code_and_message() {
        let json = serde_json::to_string(&ApiError::new("SCOPE", "no")).unwrap();
        assert_eq!(json, r#"{"code":"SCOPE","message":"no"}"#);
    }
}
