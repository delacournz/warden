//! The once-a-second `stats` line: our own send counters plus what the peer connection reports
//! (selected candidate pair, RTT, receiver-reported loss, NACKs).

use crate::ice::classify;
use crate::signal::{Network, PathKind, Stats};
use rtc::statistics::report::{RTCStatsReport, RTCStatsReportEntry};
use serde_json::Value;
use std::time::Duration;

/// Counters the sender keeps itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counters {
    pub units_sent: u64,
    /// RTP bytes (header + payload) handed to the track.
    pub rtp_bytes: u64,
    pub units_dropped: u64,
    pub plis: u64,
}

/// What the peer connection's report says.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Report {
    pub rtt_ms: Option<f64>,
    pub packets_sent: u64,
    pub packets_lost: i64,
    pub nacks: u64,
    pub path: Option<PathKind>,
    pub network: Option<Network>,
    /// Bytes sent on the selected pair (UDP payload, RTCP and data channel included).
    pub pair_bytes_sent: u64,
    /// The selected pair's id: a change means a new pair, whose byte counter starts again.
    pub pair_id: String,
}

/// Turns counter snapshots into per-interval rates and keeps the relayed-bytes total.
#[derive(Default)]
pub struct Tracker {
    last: Counters,
    last_pair: Option<(String, u64)>,
    relayed_bytes: u64,
    bytes_sent: u64,
}

impl Tracker {
    pub fn tick(&mut self, now: Counters, report: &Report, interval: Duration) -> Stats {
        let secs = interval.as_secs_f64().max(1e-3);
        let units = now.units_sent.saturating_sub(self.last.units_sent);
        let bytes = now.rtp_bytes.saturating_sub(self.last.rtp_bytes);
        self.last = now;

        let delta = match &self.last_pair {
            Some((id, before)) if *id == report.pair_id => {
                report.pair_bytes_sent.saturating_sub(*before)
            }
            _ => report.pair_bytes_sent,
        };
        if !report.pair_id.is_empty() {
            self.last_pair = Some((report.pair_id.clone(), report.pair_bytes_sent));
            self.bytes_sent += delta;
            if report.path == Some(PathKind::Relay) {
                self.relayed_bytes += delta;
            }
        }

        Stats {
            fps: (units as f64 / secs * 10.0).round() / 10.0,
            bitrate: (bytes as f64 * 8.0 / secs) as u64,
            rtt_ms: report.rtt_ms,
            packets_sent: report.packets_sent,
            packets_lost: report.packets_lost,
            nacks: report.nacks,
            plis: now.plis,
            units_sent: now.units_sent,
            units_dropped: now.units_dropped,
            path: report.path,
            network: report.network,
            relayed_bytes: self.relayed_bytes,
            bytes_sent: self.bytes_sent,
        }
    }
}

fn path_kind(typ: &str) -> Option<PathKind> {
    match typ {
        "host" => Some(PathKind::Host),
        "srflx" => Some(PathKind::Srflx),
        "prflx" => Some(PathKind::Prflx),
        "relay" => Some(PathKind::Relay),
        _ => None,
    }
}

fn entry_json(entry: &RTCStatsReportEntry) -> Option<Value> {
    let v = match entry {
        RTCStatsReportEntry::Transport(s) => serde_json::to_value(s),
        RTCStatsReportEntry::IceCandidatePair(s) => serde_json::to_value(s),
        RTCStatsReportEntry::LocalCandidate(s) | RTCStatsReportEntry::RemoteCandidate(s) => {
            serde_json::to_value(s)
        }
        RTCStatsReportEntry::OutboundRtp(s) => serde_json::to_value(s),
        RTCStatsReportEntry::RemoteInboundRtp(s) => serde_json::to_value(s),
        _ => return None,
    };
    v.ok()
}

fn u64_of(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Pull the fields we report out of the peer connection's stats.
pub fn read_report(report: &RTCStatsReport) -> Report {
    let entries: Vec<Value> = report.iter().filter_map(entry_json).collect();
    read_entries(&entries)
}

/// The same, from the W3C-shaped JSON of each entry (`type`, `id`, camelCase fields).
pub fn read_entries(entries: &[Value]) -> Report {
    let typ = |v: &Value| {
        v.get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let mut out = Report::default();
    let mut selected = "";
    let mut pairs = Vec::new();
    let mut candidates = Vec::new();
    for v in entries {
        match typ(v).as_str() {
            "transport" => {
                selected = v
                    .get("selectedCandidatePairId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
            }
            "candidate-pair" => pairs.push(v),
            "local-candidate" | "remote-candidate" => candidates.push(v),
            "outbound-rtp" => {
                out.packets_sent += u64_of(v, "packetsSent");
                out.nacks += u64_of(v, "nackCount");
            }
            "remote-inbound-rtp" => {
                out.packets_lost += v.get("packetsLost").and_then(Value::as_i64).unwrap_or(0);
            }
            _ => {}
        }
    }
    let id_of = |v: &Value| {
        v.get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let pair = pairs
        .iter()
        .find(|p| !selected.is_empty() && id_of(p) == selected)
        .or_else(|| {
            pairs.iter().find(|p| {
                p.get("nominated").and_then(Value::as_bool) == Some(true)
                    && p.get("state").and_then(Value::as_str) == Some("succeeded")
            })
        });
    let Some(pair) = pair else { return out };
    out.pair_id = id_of(pair);
    out.pair_bytes_sent = u64_of(pair, "bytesSent");
    out.rtt_ms = pair
        .get("currentRoundTripTime")
        .and_then(Value::as_f64)
        .filter(|rtt| *rtt > 0.0)
        .map(|rtt| (rtt * 1000.0 * 100.0).round() / 100.0);
    // A pair names its candidates `candidate:X`; the candidate entries are `RTCLocalIceCandidate_candidate:X`.
    let candidate = |kind: &str, field: &str| {
        let wanted = pair.get(field).and_then(Value::as_str)?;
        let suffix = format!("_{wanted}");
        candidates
            .iter()
            .find(|c| typ(c) == kind && (id_of(c) == wanted || id_of(c).ends_with(&suffix)))
            .copied()
    };
    out.path = candidate("local-candidate", "localCandidateId")
        .and_then(|c| c.get("candidateType"))
        .and_then(Value::as_str)
        .and_then(path_kind);
    out.network = candidate("remote-candidate", "remoteCandidateId")
        .and_then(|c| c.get("address"))
        .and_then(Value::as_str)
        .and_then(|a| a.parse().ok())
        .map(classify);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counters(units_sent: u64, rtp_bytes: u64) -> Counters {
        Counters {
            units_sent,
            rtp_bytes,
            ..Default::default()
        }
    }

    fn report(pair: &str, bytes: u64, path: PathKind) -> Report {
        Report {
            pair_id: pair.into(),
            pair_bytes_sent: bytes,
            path: Some(path),
            ..Default::default()
        }
    }

    #[test]
    fn rates_cover_the_last_interval_only() {
        let mut t = Tracker::default();
        let one = Duration::from_secs(1);
        let first = t.tick(counters(60, 250_000), &Report::default(), one);
        assert_eq!(first.fps, 60.0);
        assert_eq!(first.bitrate, 2_000_000);
        let second = t.tick(counters(90, 375_000), &Report::default(), one);
        assert_eq!(second.fps, 30.0);
        assert_eq!(second.bitrate, 1_000_000);
        assert_eq!(second.units_sent, 90);
        let half = t.tick(counters(120, 375_000), &Report::default(), one / 2);
        assert_eq!(half.fps, 60.0);
        assert_eq!(half.bitrate, 0);
    }

    #[test]
    fn relayed_bytes_count_only_while_the_selected_pair_is_relay() {
        let mut t = Tracker::default();
        let one = Duration::from_secs(1);
        let s = t.tick(
            Counters::default(),
            &report("p1", 1_000, PathKind::Host),
            one,
        );
        assert_eq!((s.relayed_bytes, s.bytes_sent), (0, 1_000));
        let s = t.tick(
            Counters::default(),
            &report("p1", 3_000, PathKind::Host),
            one,
        );
        assert_eq!((s.relayed_bytes, s.bytes_sent), (0, 3_000));
        // ICE switched to a relayed pair: its counter starts from zero.
        let s = t.tick(
            Counters::default(),
            &report("p2", 500, PathKind::Relay),
            one,
        );
        assert_eq!((s.relayed_bytes, s.bytes_sent), (500, 3_500));
        let s = t.tick(
            Counters::default(),
            &report("p2", 2_500, PathKind::Relay),
            one,
        );
        assert_eq!((s.relayed_bytes, s.bytes_sent), (2_500, 5_500));
        assert_eq!(s.path, Some(PathKind::Relay));
        // No pair yet / any more: nothing is added.
        let s = t.tick(Counters::default(), &Report::default(), one);
        assert_eq!((s.relayed_bytes, s.bytes_sent), (2_500, 5_500));
    }

    #[test]
    fn reads_the_selected_pair_as_webrtc_rs_reports_it() {
        let entries: Vec<Value> = [
            r#"{"type":"transport","id":"RTCTransport","selectedCandidatePairId":"RTCIceCandidatePair_candidate:L1_candidate:R1"}"#,
            r#"{"type":"candidate-pair","id":"RTCIceCandidatePair_candidate:L0_candidate:R0","localCandidateId":"candidate:L0","remoteCandidateId":"candidate:R0","bytesSent":1,"nominated":false,"state":"failed"}"#,
            r#"{"type":"candidate-pair","id":"RTCIceCandidatePair_candidate:L1_candidate:R1","localCandidateId":"candidate:L1","remoteCandidateId":"candidate:R1","bytesSent":25253,"currentRoundTripTime":0.012345,"nominated":true,"state":"succeeded"}"#,
            r#"{"type":"local-candidate","id":"RTCLocalIceCandidate_candidate:L0","candidateType":"host","address":"192.168.1.2"}"#,
            r#"{"type":"local-candidate","id":"RTCLocalIceCandidate_candidate:L1","candidateType":"relay","address":"104.30.1.1"}"#,
            r#"{"type":"remote-candidate","id":"RTCRemoteIceCandidate_candidate:R1","candidateType":"relay","address":"100.100.1.7"}"#,
            r#"{"type":"outbound-rtp","id":"o","packetsSent":121,"nackCount":3}"#,
            r#"{"type":"remote-inbound-rtp","id":"ri","packetsLost":2}"#,
        ]
        .iter()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
        let r = read_entries(&entries);
        assert_eq!(r.pair_id, "RTCIceCandidatePair_candidate:L1_candidate:R1");
        assert_eq!(r.pair_bytes_sent, 25253);
        assert_eq!(r.rtt_ms, Some(12.35));
        assert_eq!(r.path, Some(PathKind::Relay));
        assert_eq!(r.network, Some(Network::Tailnet));
        assert_eq!((r.packets_sent, r.nacks, r.packets_lost), (121, 3, 2));
        assert_eq!(read_entries(&[]), Report::default());
    }

    #[test]
    fn maps_candidate_types() {
        assert_eq!(path_kind("host"), Some(PathKind::Host));
        assert_eq!(path_kind("srflx"), Some(PathKind::Srflx));
        assert_eq!(path_kind("prflx"), Some(PathKind::Prflx));
        assert_eq!(path_kind("relay"), Some(PathKind::Relay));
        assert_eq!(path_kind("unspecified"), None);
    }
}
