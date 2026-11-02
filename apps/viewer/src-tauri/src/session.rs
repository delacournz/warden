//! The session handed over on stdin, and the stdout events going back.
//!
//! The first stdin line is the whole session; every later line is a token refresh. The token lives
//! in `SessionState` and is never serialised towards the webview.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::sync::RwLock;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    View,
    Drive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Ios,
    Android,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub api_url: String,
    pub device_id: String,
    pub token: String,
    pub expires_at: String,
    pub scope: Scope,
    pub title: String,
    pub platform: Platform,
    /// The parent will not keep stdin open: EOF no longer ends the session, expiry does.
    #[serde(default)]
    pub detached: bool,
    /// Where `open_billing` sends the user. https only; anything else is dropped at parse time.
    #[serde(default)]
    pub billing_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refresh {
    pub token: String,
    pub expires_at: String,
}

/// What the webview may know: everything except the token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewerInfo {
    pub device_id: String,
    pub scope: Scope,
    pub title: String,
    pub platform: Platform,
    pub expires_at: String,
    pub detached: bool,
    pub expired: bool,
    pub has_billing_url: bool,
}

/// Credentials for one outgoing request.
#[derive(Debug, Clone)]
pub struct Credentials {
    pub api_url: String,
    pub device_id: String,
    pub token: String,
    pub scope: Scope,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    Eof,
    Read(String),
    Invalid(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Eof => write!(f, "stdin closed before the session line"),
            StartError::Read(e) => write!(f, "could not read stdin: {e}"),
            StartError::Invalid(e) => write!(f, "invalid session JSON: {e}"),
        }
    }
}

/// Keep a billing URL only when it is an absolute `https://` URL with a host, or plain `http://` on a
/// loopback host (`localhost`, `127.0.0.1`, `::1`) so a local dev web app works.
pub fn sanitize_billing_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    match url.scheme() {
        "https" => Some(url.to_string()),
        "http" if loopback => Some(url.to_string()),
        _ => None,
    }
}

pub fn parse_session(line: &str) -> Result<Session, StartError> {
    let mut session: Session =
        serde_json::from_str(line.trim()).map_err(|e| StartError::Invalid(e.to_string()))?;
    if session.api_url.is_empty() || session.device_id.is_empty() || session.token.is_empty() {
        return Err(StartError::Invalid(
            "apiUrl, deviceId and token must be non-empty".into(),
        ));
    }
    if let Some(raw) = session.billing_url.take() {
        session.billing_url = sanitize_billing_url(&raw);
        if session.billing_url.is_none() {
            log::warn!("ignoring billingUrl: not an https:// (or loopback http://) URL");
        }
    }
    Ok(session)
}

pub fn parse_refresh(line: &str) -> Result<Refresh, String> {
    let refresh: Refresh = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    if refresh.token.is_empty() {
        return Err("refresh token is empty".into());
    }
    Ok(refresh)
}

/// Read the first line of `reader` as the session.
pub fn read_start<R: BufRead>(reader: &mut R) -> Result<Session, StartError> {
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .map_err(|e| StartError::Read(e.to_string()))?;
    if read == 0 {
        return Err(StartError::Eof);
    }
    parse_session(&line)
}

pub struct SessionState(RwLock<Session>);

impl SessionState {
    pub fn new(session: Session) -> Self {
        Self(RwLock::new(session))
    }

    pub fn apply_refresh(&self, refresh: Refresh) {
        let mut session = self.0.write().unwrap_or_else(|e| e.into_inner());
        session.token = refresh.token;
        session.expires_at = refresh.expires_at;
    }

    pub fn info(&self) -> ViewerInfo {
        let s = self.0.read().unwrap_or_else(|e| e.into_inner());
        ViewerInfo {
            device_id: s.device_id.clone(),
            scope: s.scope,
            title: s.title.clone(),
            platform: s.platform,
            expires_at: s.expires_at.clone(),
            detached: s.detached,
            expired: is_expired(&s.expires_at, OffsetDateTime::now_utc()),
            has_billing_url: s.billing_url.is_some(),
        }
    }

    pub fn billing_url(&self) -> Option<String> {
        self.0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .billing_url
            .clone()
    }

    pub fn detached(&self) -> bool {
        self.0.read().unwrap_or_else(|e| e.into_inner()).detached
    }

    pub fn expires_at(&self) -> String {
        self.0
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .expires_at
            .clone()
    }

    pub fn credentials(&self) -> Credentials {
        let s = self.0.read().unwrap_or_else(|e| e.into_inner());
        Credentials {
            api_url: s.api_url.clone(),
            device_id: s.device_id.clone(),
            token: s.token.clone(),
            scope: s.scope,
        }
    }
}

/// Apply every remaining line as a refresh, then call `on_eof`. A malformed line is logged and
/// skipped so one bad refresh never ends the session.
pub fn pump_refreshes<R: BufRead>(reader: R, state: &SessionState, on_eof: impl FnOnce()) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match parse_refresh(&line) {
            Ok(refresh) => state.apply_refresh(refresh),
            Err(e) => log::warn!("ignoring stdin line: {e}"),
        }
    }
    on_eof();
}

/// True once `expires_at` (RFC 3339) is not after `now`. An unparseable value counts as expired, so
/// a malformed token never keeps a detached window live.
pub fn is_expired(expires_at: &str, now: OffsetDateTime) -> bool {
    match OffsetDateTime::parse(expires_at, &Rfc3339) {
        Ok(at) => at <= now,
        Err(_) => true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EofAction {
    /// The parent died: close the window and exit 0.
    Exit,
    /// Detached: keep the token we hold until it expires.
    HoldUntilExpiry,
}

pub fn eof_action(detached: bool) -> EofAction {
    if detached {
        EofAction::HoldUntilExpiry
    } else {
        EofAction::Exit
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum Event<'a> {
    Ready,
    Streaming,
    Error { message: &'a str },
}

pub fn event_line(event: &Event) -> String {
    serde_json::to_string(event).unwrap_or_else(|_| "{\"event\":\"error\"}".into())
}

/// One JSON line on stdout. The contract allows nothing else there.
pub fn emit(event: &Event) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", event_line(event));
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const START: &str = r#"{"apiUrl":"https://api.warden.co.nz","deviceId":"d1","token":"wvt_a","expiresAt":"2030-01-01T00:00:00Z","scope":"drive","title":"iphone-17 · warden","platform":"ios","detached":false}"#;

    #[test]
    fn parses_the_start_line() {
        let s = parse_session(START).unwrap();
        assert_eq!(s.device_id, "d1");
        assert_eq!(s.scope, Scope::Drive);
        assert_eq!(s.platform, Platform::Ios);
        assert_eq!(s.title, "iphone-17 · warden");
    }

    #[test]
    fn rejects_bad_json_and_empty_fields() {
        assert!(matches!(parse_session("nope"), Err(StartError::Invalid(_))));
        let empty = START.replace("wvt_a", "");
        assert!(matches!(parse_session(&empty), Err(StartError::Invalid(_))));
        let bad_scope = START.replace("drive", "admin");
        assert!(matches!(
            parse_session(&bad_scope),
            Err(StartError::Invalid(_))
        ));
    }

    #[test]
    fn read_start_reports_eof() {
        let mut empty = Cursor::new(Vec::new());
        assert!(matches!(read_start(&mut empty), Err(StartError::Eof)));
    }

    #[test]
    fn read_start_takes_only_the_first_line() {
        let input = format!("{START}\n{{\"token\":\"wvt_b\",\"expiresAt\":\"x\"}}\n");
        let mut cursor = Cursor::new(input.into_bytes());
        assert!(read_start(&mut cursor).is_ok());
        let mut rest = String::new();
        cursor.read_line(&mut rest).unwrap();
        assert!(rest.contains("wvt_b"));
    }

    #[test]
    fn refresh_replaces_the_token_in_memory() {
        let state = SessionState::new(parse_session(START).unwrap());
        state.apply_refresh(
            parse_refresh(r#"{"token":"wvt_b","expiresAt":"2031-01-01T00:00:00Z"}"#).unwrap(),
        );
        assert_eq!(state.credentials().token, "wvt_b");
        assert_eq!(state.info().expires_at, "2031-01-01T00:00:00Z");
    }

    #[test]
    fn pump_applies_refreshes_skips_junk_and_signals_eof() {
        let state = SessionState::new(parse_session(START).unwrap());
        let input = "{\"token\":\"wvt_b\",\"expiresAt\":\"e1\"}\nnot json\n\n{\"token\":\"wvt_c\",\"expiresAt\":\"e2\"}\n";
        let mut eof = false;
        pump_refreshes(Cursor::new(input.as_bytes()), &state, || eof = true);
        assert!(eof);
        assert_eq!(state.credentials().token, "wvt_c");
    }

    #[test]
    fn info_never_serialises_the_token() {
        let state = SessionState::new(parse_session(START).unwrap());
        let json = serde_json::to_string(&state.info()).unwrap();
        assert!(!json.contains("wvt_a"));
        assert!(!json.contains("token"));
        assert!(json.contains("\"deviceId\":\"d1\""));
        assert!(json.contains("\"scope\":\"drive\""));
    }

    #[test]
    fn detached_defaults_to_false_and_parses_true() {
        assert!(!parse_session(START).unwrap().detached);
        let detached = START.replace("\"detached\":false", "\"detached\":true");
        assert!(parse_session(&detached).unwrap().detached);
        assert!(SessionState::new(parse_session(&detached).unwrap()).detached());
    }

    #[test]
    fn eof_closes_when_attached_and_holds_when_detached() {
        assert_eq!(eof_action(false), EofAction::Exit);
        assert_eq!(eof_action(true), EofAction::HoldUntilExpiry);
    }

    #[test]
    fn expiry_is_judged_against_the_clock() {
        let now = OffsetDateTime::parse("2030-01-01T00:00:00Z", &Rfc3339).unwrap();
        assert!(!is_expired("2030-01-01T00:00:01Z", now));
        assert!(is_expired("2030-01-01T00:00:00Z", now));
        assert!(is_expired("2029-12-31T23:59:59Z", now));
        assert!(is_expired("not a date", now));
    }

    #[test]
    fn info_reports_expired_and_detached() {
        let past = START.replace("2030-01-01T00:00:00Z", "2001-01-01T00:00:00Z");
        let info = SessionState::new(parse_session(&past).unwrap()).info();
        assert!(info.expired);
        assert!(!info.detached);
        assert!(
            !SessionState::new(parse_session(START).unwrap())
                .info()
                .expired
        );
    }

    #[test]
    fn billing_url_is_optional_and_https_only() {
        assert_eq!(parse_session(START).unwrap().billing_url, None);
        let ok = START.replace(
            "\"detached\":false",
            "\"detached\":false,\"billingUrl\":\"https://app.warden.co.nz/billing\"",
        );
        let s = parse_session(&ok).unwrap();
        assert_eq!(
            s.billing_url.as_deref(),
            Some("https://app.warden.co.nz/billing")
        );
        assert!(SessionState::new(s).info().has_billing_url);
        for bad in [
            "http://app.warden.co.nz/billing",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url",
            "https://",
            "",
        ] {
            let line = START.replace(
                "\"detached\":false",
                &format!("\"detached\":false,\"billingUrl\":\"{bad}\""),
            );
            let s = parse_session(&line).unwrap();
            assert_eq!(s.billing_url, None, "{bad}");
            assert!(!SessionState::new(s).info().has_billing_url);
        }
    }

    #[test]
    fn billing_url_allows_plain_http_only_on_loopback() {
        for local in [
            "http://localhost:3012/billing",
            "http://127.0.0.1:3012/billing",
            "http://[::1]:3012/billing",
        ] {
            assert_eq!(
                sanitize_billing_url(local).as_deref(),
                Some(local),
                "{local}"
            );
        }
        for remote in [
            "http://localhost.evil.example/billing",
            "http://10.0.0.1/billing",
            "http://0.0.0.0:3012/billing",
            "ftp://localhost/billing",
        ] {
            assert_eq!(sanitize_billing_url(remote), None, "{remote}");
        }
    }

    #[test]
    fn info_exposes_only_whether_a_billing_url_exists() {
        let line = START.replace(
            "\"detached\":false",
            "\"detached\":false,\"billingUrl\":\"https://app.warden.co.nz/billing\"",
        );
        let json = serde_json::to_string(&SessionState::new(parse_session(&line).unwrap()).info())
            .unwrap();
        assert!(json.contains("\"hasBillingUrl\":true"));
        assert!(!json.contains("app.warden.co.nz"));
    }

    #[test]
    fn events_serialise_to_the_contract() {
        assert_eq!(event_line(&Event::Ready), r#"{"event":"ready"}"#);
        assert_eq!(event_line(&Event::Streaming), r#"{"event":"streaming"}"#);
        assert_eq!(
            event_line(&Event::Error { message: "boom" }),
            r#"{"event":"error","message":"boom"}"#
        );
    }
}
