//! The stdio signalling protocol: one JSON object per line, tagged by `t`.
//!
//! The publisher is the offerer. It writes [`Out`] lines on stdout and reads [`In`] lines on stdin;
//! the caller relays them to the viewer over whatever channel it already authenticates (ssh stdio,
//! the relay). Field names are the browser's (`sdpMid`, `sdpMLineIndex`), so a viewer can hand a
//! candidate line straight to `addIceCandidate`.

use serde::{Deserialize, Serialize};

/// One trickled ICE candidate, as `RTCIceCandidateInit` spells it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candidate {
    pub candidate: String,
    #[serde(rename = "sdpMid", default, skip_serializing_if = "Option::is_none")]
    pub sdp_mid: Option<String>,
    #[serde(
        rename = "sdpMLineIndex",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sdp_mline_index: Option<u16>,
}

/// Why the publisher wants a keyframe from the encoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyframeReason {
    /// The receiver sent an RTCP PLI or FIR.
    Pli,
    /// The peer connection just connected: media starts on a keyframe.
    Connected,
    /// Access units were dropped (a backlog was cut); the stream resumes on a keyframe.
    Drop,
}

/// The ICE candidate type of the selected pair's local side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathKind {
    Host,
    Srflx,
    Prflx,
    Relay,
}

/// Which network the selected pair's remote address is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Network {
    Loopback,
    /// RFC 1918 / RFC 4193 / link-local: the same LAN.
    Lan,
    /// Tailscale's CGNAT range `100.64.0.0/10` or `fd7a:115c:a1e0::/48`.
    Tailnet,
    Public,
}

/// The once-a-second report. Rates cover the last interval; counters are totals since start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Access units sent per second over the last interval.
    pub fps: f64,
    /// RTP payload + header bits per second over the last interval.
    pub bitrate: u64,
    /// Round trip time of the selected candidate pair, ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<f64>,
    pub packets_sent: u64,
    /// Packets the receiver reported lost (RTCP receiver reports).
    pub packets_lost: i64,
    /// NACKs received; each is answered from the responder's buffer.
    pub nacks: u64,
    /// PLI + FIR received.
    pub plis: u64,
    pub units_sent: u64,
    /// Access units dropped before sending: before connect, a cut backlog, or waiting for a keyframe.
    pub units_dropped: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<Network>,
    /// Bytes on the wire (UDP payload) sent while the selected pair was relayed, since start.
    pub relayed_bytes: u64,
    /// All bytes sent on the selected transport, since start.
    pub bytes_sent: u64,
}

/// Publisher → caller (stdout).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum Out {
    Offer {
        sdp: String,
    },
    Candidate(Candidate),
    EndOfCandidates,
    /// The peer connection state: `new`, `connecting`, `connected`, `disconnected`, `failed`, `closed`.
    State {
        state: String,
    },
    KeyframeRequest {
        reason: KeyframeReason,
    },
    /// One data channel text message, verbatim.
    Input {
        channel: String,
        data: String,
    },
    Stats(Stats),
    /// A fatal or rejected request; `code` is stable (`USAGE`, `UNSUPPORTED`, `SOURCE`, `RTC`, `SIGNAL`).
    Error {
        code: String,
        message: String,
    },
}

/// Caller → publisher (stdin).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum In {
    Answer { sdp: String },
    Candidate(Candidate),
    EndOfCandidates,
    Close,
}

impl Out {
    /// One NDJSON line, without the newline.
    pub fn line(&self) -> String {
        // Every variant is plain data: serializing cannot fail.
        serde_json::to_string(self).unwrap_or_else(|_| String::from(r#"{"t":"error"}"#))
    }
}

impl In {
    pub fn parse(line: &str) -> Result<Self, String> {
        serde_json::from_str(line).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn candidate() -> Candidate {
        Candidate {
            candidate: "candidate:1 1 udp 2130706431 100.101.1.2 50000 typ host".into(),
            sdp_mid: Some("0".into()),
            sdp_mline_index: Some(0),
        }
    }

    fn round_trip_out(out: Out, expected: Value) {
        let line = out.line();
        assert!(!line.contains('\n'));
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), expected);
        assert_eq!(serde_json::from_str::<Out>(&line).unwrap(), out);
    }

    #[test]
    fn out_lines_have_the_documented_shape() {
        round_trip_out(
            Out::Offer { sdp: "v=0".into() },
            json!({"t":"offer","sdp":"v=0"}),
        );
        round_trip_out(
            Out::Candidate(candidate()),
            json!({"t":"candidate","candidate":candidate().candidate,"sdpMid":"0","sdpMLineIndex":0}),
        );
        round_trip_out(Out::EndOfCandidates, json!({"t":"end-of-candidates"}));
        round_trip_out(
            Out::State {
                state: "connected".into(),
            },
            json!({"t":"state","state":"connected"}),
        );
        for (reason, name) in [
            (KeyframeReason::Pli, "pli"),
            (KeyframeReason::Connected, "connected"),
            (KeyframeReason::Drop, "drop"),
        ] {
            round_trip_out(
                Out::KeyframeRequest { reason },
                json!({"t":"keyframe-request","reason":name}),
            );
        }
        round_trip_out(
            Out::Input {
                channel: "input".into(),
                data: r#"{"type":"down"}"#.into(),
            },
            json!({"t":"input","channel":"input","data":"{\"type\":\"down\"}"}),
        );
        round_trip_out(
            Out::Error {
                code: "UNSUPPORTED".into(),
                message: "no".into(),
            },
            json!({"t":"error","code":"UNSUPPORTED","message":"no"}),
        );
    }

    #[test]
    fn stats_lines_are_camel_case_and_omit_unknowns() {
        let stats = Stats {
            fps: 59.5,
            bitrate: 2_000_000,
            rtt_ms: Some(1.5),
            packets_sent: 10,
            packets_lost: 1,
            nacks: 2,
            plis: 3,
            units_sent: 4,
            units_dropped: 5,
            path: Some(PathKind::Relay),
            network: Some(Network::Tailnet),
            relayed_bytes: 6,
            bytes_sent: 7,
        };
        round_trip_out(
            Out::Stats(stats),
            json!({"t":"stats","fps":59.5,"bitrate":2000000,"rttMs":1.5,"packetsSent":10,"packetsLost":1,
                "nacks":2,"plis":3,"unitsSent":4,"unitsDropped":5,"path":"relay","network":"tailnet",
                "relayedBytes":6,"bytesSent":7}),
        );
        let bare = Out::Stats(Stats::default()).line();
        let v: Value = serde_json::from_str(&bare).unwrap();
        assert!(v.get("rttMs").is_none() && v.get("path").is_none() && v.get("network").is_none());
    }

    #[test]
    fn in_lines_parse_and_round_trip() {
        let cases = [
            (
                r#"{"t":"answer","sdp":"v=0"}"#,
                In::Answer { sdp: "v=0".into() },
            ),
            (
                r#"{"t":"candidate","candidate":"candidate:1 1 udp 2130706431 100.101.1.2 50000 typ host","sdpMid":"0","sdpMLineIndex":0}"#,
                In::Candidate(candidate()),
            ),
            (r#"{"t":"end-of-candidates"}"#, In::EndOfCandidates),
            (r#"{"t":"close"}"#, In::Close),
        ];
        for (line, expected) in cases {
            let parsed = In::parse(line).unwrap();
            assert_eq!(parsed, expected);
            let again = serde_json::to_string(&parsed).unwrap();
            assert_eq!(In::parse(&again).unwrap(), expected);
        }
    }

    #[test]
    fn a_browser_candidate_without_mid_or_index_parses() {
        let parsed = In::parse(r#"{"t":"candidate","candidate":"candidate:x"}"#).unwrap();
        assert_eq!(
            parsed,
            In::Candidate(Candidate {
                candidate: "candidate:x".into(),
                sdp_mid: None,
                sdp_mline_index: None,
            })
        );
    }

    #[test]
    fn rejects_unknown_tags_and_garbage() {
        assert!(In::parse(r#"{"t":"offer","sdp":"x"}"#).is_err());
        assert!(In::parse("not json").is_err());
        assert!(In::parse(r#"{"sdp":"x"}"#).is_err());
    }
}
