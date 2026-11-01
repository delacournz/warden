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
    fn new(code: &str, message: impl Into<String>) -> Self {
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
fn viewer_for(registry: &Registry, label: &str) -> CmdResult<Arc<Viewer>> {
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

async fn ok_or_failure(response: reqwest::Response) -> CmdResult<reqwest::Response> {
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
    ok_or_failure(response).await?;
    Ok(())
}

#[tauri::command]
pub fn viewer_info(
    window: tauri::WebviewWindow,
    registry: State<'_, Registry>,
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

/// Close from the window's prompt and exit 0. Attached, it first tells the CLI the choice on stdout:
/// `release` = Shut down (the CLI stops the device and ends the lease), otherwise Keep running. A
/// detached viewer has no CLI listening, so it refuses `release` and closes without a line.
#[tauri::command]
pub fn close_viewer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, Registry>,
    release: bool,
) -> CmdResult<()> {
    let viewer = viewer_for(&registry, window.label())?;
    if viewer.session.detached() {
        if release {
            return Err(ApiError::new(
                "DETACHED",
                "a detached viewer can't end the lease; run warden release",
            ));
        }
    } else {
        viewer.send(&Event::Close { release });
    }
    app.exit(0);
    Ok(())
}

/// Open the launch-time billing URL in the system browser. Takes no argument: JS cannot choose
/// where this goes.
#[tauri::command]
pub fn open_billing(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, Registry>,
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
    registry: State<'_, Registry>,
) -> CmdResult<WhepAnswer> {
    let viewer = viewer_for(&registry, window.label())?;
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
    Ok(WhepAnswer { sdp: answer })
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
    registry: State<'_, Registry>,
) -> CmdResult<()> {
    let viewer = viewer_for(&registry, window.label())?;
    let c = viewer.session.credentials();
    if let Some(resource) = viewer.take_resource() {
        delete_resource(registry.client(), &c, resource).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn tap(
    x: i64,
    y: i64,
    window: tauri::WebviewWindow,
    registry: State<'_, Registry>,
) -> CmdResult<()> {
    let viewer = viewer_for(&registry, window.label())?;
    let c = viewer.session.credentials();
    require_drive(&c)?;
    post_json(
        registry.client(),
        &c,
        "/tap",
        serde_json::json!({ "x": x, "y": y }),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn swipe(
    from_x: i64,
    from_y: i64,
    to_x: i64,
    to_y: i64,
    duration_ms: Option<u32>,
    window: tauri::WebviewWindow,
    registry: State<'_, Registry>,
) -> CmdResult<()> {
    let viewer = viewer_for(&registry, window.label())?;
    let c = viewer.session.credentials();
    require_drive(&c)?;
    let mut body = serde_json::json!({
        "fromX": from_x, "fromY": from_y, "toX": to_x, "toY": to_y,
    });
    if let Some(ms) = duration_ms {
        body["durationMs"] = ms.into();
    }
    post_json(registry.client(), &c, "/swipe", body).await
}

#[tauri::command]
pub async fn input(
    text: String,
    clear_first: Option<bool>,
    window: tauri::WebviewWindow,
    registry: State<'_, Registry>,
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
    registry: State<'_, Registry>,
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

/// Fetch a PNG, ask where to save it, write it. Returns the path, or None when the panel was
/// cancelled.
#[tauri::command]
pub async fn screenshot(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, Registry>,
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

/// JS calls this when the first frame plays. The event goes to this window's sink, once per session.
#[tauri::command]
pub fn viewer_streaming(
    window: tauri::WebviewWindow,
    registry: State<'_, Registry>,
) -> CmdResult<()> {
    viewer_for(&registry, window.label())?.announce_streaming();
    Ok(())
}

/// Resize the window so the video area has the device's aspect ratio. `chrome_height` is the
/// logical height of everything around the video (bar and insets) and `pad_x` the horizontal
/// insets; the window keeps its height and changes its width, shrinking both when
/// the result would not fit the monitor.
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
    let scale = window
        .scale_factor()
        .map_err(|e| ApiError::new("WINDOW", e.to_string()))?;
    let inner = window
        .inner_size()
        .map_err(|e| ApiError::new("WINDOW", e.to_string()))?;
    let (mut width, mut height) =
        fit_size(aspect, chrome_height, pad_x, inner.height as f64 / scale);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let m = monitor.size();
        let (max_w, max_h) = (m.width as f64 / scale * 0.9, m.height as f64 / scale * 0.9);
        if width > max_w || height > max_h {
            let shrink = (max_w / width).min(max_h / height);
            (width, height) = fit_size(aspect, chrome_height, pad_x, height * shrink);
        }
    }
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| ApiError::new("WINDOW", e.to_string()))?;
    Ok(())
}

/// Window size (logical) that keeps `height` and gives the video area, inside `chrome_height` of
/// bar and insets and `pad_x` of side insets, the requested aspect ratio.
pub fn fit_size(aspect: f64, chrome_height: f64, pad_x: f64, height: f64) -> (f64, f64) {
    let video_height = (height - chrome_height).max(1.0);
    ((video_height * aspect + pad_x).round(), height.round())
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
    fn fit_size_keeps_height_and_derives_width() {
        assert_eq!(fit_size(0.5, 48.0, 12.0, 888.0), (432.0, 888.0));
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
