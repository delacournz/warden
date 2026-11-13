//! Billing state polled from `GET /v1/devices/:id`: what the webview is told, and when to stop.
//!
//! Pure parsing and decisions live here; the thread loop and HTTP are in `lib.rs` / `device.rs`.

use serde::{Deserialize, Serialize};

pub const POLL_INTERVAL_SECS: u64 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus {
    Starting,
    Ready,
    Stopping,
    Stopped,
    Failed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    User,
    Idle,
    CreditsExhausted,
    Error,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BillingBody {
    low_balance: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceBody {
    status: DeviceStatus,
    stop_reason: Option<StopReason>,
    billing: Option<BillingBody>,
}

/// The parts of a `RemoteDevice` the viewer acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceSnapshot {
    pub status: DeviceStatus,
    pub stop_reason: Option<StopReason>,
    pub low_balance: Option<bool>,
}

pub fn parse_device(body: &str) -> Result<DeviceSnapshot, String> {
    let b: DeviceBody = serde_json::from_str(body).map_err(|e| e.to_string())?;
    Ok(DeviceSnapshot {
        status: b.status,
        stop_reason: b.stop_reason,
        low_balance: b.billing.map(|x| x.low_balance),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingPayload {
    pub low_balance: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StoppedPayload {
    pub reason: StopReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Emission {
    /// `viewer-billing`
    Billing(BillingPayload),
    /// `viewer-stopped`
    Stopped(StoppedPayload),
}

/// What one poll result asks for: events to emit (in order) and whether polling ends.
#[derive(Debug, PartialEq, Eq)]
pub struct Decision {
    pub emit: Vec<Emission>,
    pub done: bool,
}

/// `last_low` is the last `lowBalance` the window was told (false at launch). A change is emitted
/// once; a stopped or failed device emits `viewer-stopped` once and ends polling. An absent
/// `billing` block leaves the last value alone.
pub fn decide(last_low: bool, snap: &DeviceSnapshot) -> Decision {
    let mut emit = Vec::new();
    if let Some(low) = snap.low_balance {
        if low != last_low {
            emit.push(Emission::Billing(BillingPayload { low_balance: low }));
        }
    }
    let stopped = matches!(snap.status, DeviceStatus::Stopped | DeviceStatus::Failed);
    if stopped {
        let reason = snap
            .stop_reason
            .unwrap_or(if snap.status == DeviceStatus::Failed {
                StopReason::Error
            } else {
                StopReason::User
            });
        emit.push(Emission::Stopped(StoppedPayload { reason }));
    }
    Decision {
        emit,
        done: stopped,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpAction {
    Parse,
    /// 401 (token expired) and 404 (device gone): nothing more to learn.
    StopQuietly,
    /// Anything else: log and try again next tick.
    Retry,
}

pub fn classify_status(status: u16) -> HttpAction {
    match status {
        200..=299 => HttpAction::Parse,
        401 | 404 => HttpAction::StopQuietly,
        _ => HttpAction::Retry,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(status: DeviceStatus, reason: Option<StopReason>, low: Option<bool>) -> DeviceSnapshot {
        DeviceSnapshot {
            status,
            stop_reason: reason,
            low_balance: low,
        }
    }

    #[test]
    fn parses_a_ready_device_with_billing() {
        let s = parse_device(
            r#"{"id":"d1","status":"ready","billing":{"balanceUsd":0.4,"lowBalance":true}}"#,
        )
        .unwrap();
        assert_eq!(s, snap(DeviceStatus::Ready, None, Some(true)));
    }

    #[test]
    fn parses_a_stopped_device_and_tolerates_unknowns() {
        let s = parse_device(r#"{"status":"stopped","stopReason":"credits_exhausted"}"#).unwrap();
        assert_eq!(
            s,
            snap(
                DeviceStatus::Stopped,
                Some(StopReason::CreditsExhausted),
                None
            )
        );
        let s = parse_device(r#"{"status":"weird","stopReason":"new_thing"}"#).unwrap();
        assert_eq!(
            s,
            snap(DeviceStatus::Unknown, Some(StopReason::Unknown), None)
        );
        assert!(parse_device("nope").is_err());
        assert!(parse_device(r#"{"id":"d1"}"#).is_err());
    }

    #[test]
    fn low_balance_is_emitted_only_on_change() {
        let low = snap(DeviceStatus::Ready, None, Some(true));
        let d = decide(false, &low);
        assert_eq!(
            d.emit,
            vec![Emission::Billing(BillingPayload { low_balance: true })]
        );
        assert!(!d.done);
        assert!(decide(true, &low).emit.is_empty());
        let ok = snap(DeviceStatus::Ready, None, Some(false));
        assert_eq!(
            decide(true, &ok).emit,
            vec![Emission::Billing(BillingPayload { low_balance: false })]
        );
        assert!(decide(false, &ok).emit.is_empty());
    }

    #[test]
    fn absent_billing_keeps_the_last_value() {
        assert!(decide(true, &snap(DeviceStatus::Ready, None, None))
            .emit
            .is_empty());
    }

    #[test]
    fn stopped_emits_once_with_the_reason_and_ends_polling() {
        let d = decide(
            false,
            &snap(
                DeviceStatus::Stopped,
                Some(StopReason::CreditsExhausted),
                None,
            ),
        );
        assert_eq!(
            d.emit,
            vec![Emission::Stopped(StoppedPayload {
                reason: StopReason::CreditsExhausted
            })]
        );
        assert!(d.done);
    }

    #[test]
    fn stopped_without_a_reason_falls_back_by_status() {
        let user = decide(false, &snap(DeviceStatus::Stopped, None, None));
        assert_eq!(
            user.emit,
            vec![Emission::Stopped(StoppedPayload {
                reason: StopReason::User
            })]
        );
        let failed = decide(false, &snap(DeviceStatus::Failed, None, None));
        assert_eq!(
            failed.emit,
            vec![Emission::Stopped(StoppedPayload {
                reason: StopReason::Error
            })]
        );
        assert!(failed.done);
    }

    #[test]
    fn stopping_is_not_yet_stopped() {
        let d = decide(
            false,
            &snap(DeviceStatus::Stopping, Some(StopReason::Idle), None),
        );
        assert!(d.emit.is_empty());
        assert!(!d.done);
    }

    #[test]
    fn payloads_serialise_to_the_contract() {
        assert_eq!(
            serde_json::to_string(&BillingPayload { low_balance: true }).unwrap(),
            r#"{"lowBalance":true}"#
        );
        assert_eq!(
            serde_json::to_string(&StoppedPayload {
                reason: StopReason::CreditsExhausted
            })
            .unwrap(),
            r#"{"reason":"credits_exhausted"}"#
        );
    }

    #[test]
    fn http_statuses_map_to_actions() {
        assert_eq!(classify_status(200), HttpAction::Parse);
        assert_eq!(classify_status(401), HttpAction::StopQuietly);
        assert_eq!(classify_status(404), HttpAction::StopQuietly);
        assert_eq!(classify_status(500), HttpAction::Retry);
        assert_eq!(classify_status(429), HttpAction::Retry);
    }
}
