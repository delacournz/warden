//! Live bench: the publisher and a test peer in one process, so send → receive latency is measured
//! on one clock. Not a test; run by hand against a helper's stream socket or a file.
//!
//! ```text
//! cargo run --release --example live -- --au-socket <path> --helper-stdin <fifo> [--ice lan|turn] [--ice-servers-file f] [--seconds 10]
//! cargo run --release --example live -- --au-file tests/fixtures/fixture.h264 --loop
//! ```
//!
//! `--ice-servers-file` (not a flag value) keeps TURN credentials out of the process list.
//! Prints one JSON summary on stdout.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use warden_stream::ice::{self, IceMode};
use warden_stream::publisher::{Config, Sent};
use warden_stream::signal::Out;
use warden_stream::source::{self, Spec};
use warden_stream::testpeer::{PeerEvent, PeerSide, Session};
use webrtc::peer_connection::RTCPeerConnectionState;

fn pct(sorted: &[f64], p: usize) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[(sorted.len() * p / 100).min(sorted.len() - 1)]
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut spec = None;
    let mut looped = false;
    let mut mode = IceMode::Lan;
    let mut servers = Vec::new();
    let mut seconds = 10u64;
    let mut helper_stdin: Option<PathBuf> = None;
    let mut it = argv.iter();
    while let Some(flag) = it.next() {
        let mut v = || it.next().cloned().expect("flag value");
        match flag.as_str() {
            "--au-socket" => spec = Some(Spec::Socket(PathBuf::from(v()))),
            "--au-file" => {
                spec = Some(Spec::File {
                    path: PathBuf::from(v()),
                    fps: 60.0,
                    looped: false,
                })
            }
            "--loop" => looped = true,
            "--ice" => mode = v().parse().expect("--ice"),
            "--ice-servers-file" => {
                let text = std::fs::read_to_string(v()).expect("ice servers file");
                servers = ice::parse_ice_servers(&text).expect("ice servers");
            }
            "--seconds" => seconds = v().parse().expect("--seconds"),
            "--helper-stdin" => helper_stdin = Some(PathBuf::from(v())),
            other => panic!("unknown {other}"),
        }
    }
    let mut spec = spec.expect("--au-socket or --au-file");
    if let Spec::File { looped: l, .. } = &mut spec {
        *l = looped;
    }
    // Loopback binds for lan; real interfaces for turn (the relay must be reachable).
    let udp: Vec<std::net::SocketAddr> = match mode {
        IceMode::Lan => vec!["127.0.0.1:0".parse().unwrap()],
        _ => Vec::new(),
    };
    let config = Config {
        ice: mode,
        ice_servers: servers.clone(),
        udp_addrs: udp.clone(),
        ..Config::default()
    };
    let (sent_tx, mut sent_rx) = mpsc::unbounded_channel::<Sent>();
    let mut s = Session::start(
        config,
        source::start(spec),
        PeerSide {
            mode,
            servers: &servers,
            udp_addrs: &udp,
        },
        Some(sent_tx),
    )
    .await
    .expect("session");

    let mut connect_ms = None;
    let mut sent: HashMap<u32, Instant> = HashMap::new();
    let mut latencies = Vec::new();
    let mut net_latencies = Vec::new();
    let mut arrivals: Vec<Instant> = Vec::new();
    let mut first_key = None;
    let mut bytes = 0usize;
    let end = Instant::now() + Duration::from_secs(seconds + 20);
    let mut measure_until: Option<Instant> = None;
    let mut relayed = 0usize;
    let mut keyframe_seq = 0u64;
    loop {
        // What the caller (`warden __device-stream`) does: each keyframe-request → `stream.keyframe`.
        if let Some(path) = &helper_stdin {
            let requests = s
                .lines()
                .iter()
                .filter(|l| matches!(l, Out::KeyframeRequest { .. }))
                .count();
            while relayed < requests {
                relayed += 1;
                keyframe_seq += 1;
                let line = format!("{{\"id\":\"k{keyframe_seq}\",\"op\":\"stream.keyframe\"}}\n");
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(path)
                    .expect("helper stdin");
                f.write_all(line.as_bytes()).expect("write helper stdin");
            }
        }
        let now = Instant::now();
        if now >= end || measure_until.is_some_and(|t| now >= t) {
            break;
        }
        tokio::select! {
            Some(x) = sent_rx.recv() => { sent.insert(x.rtp_timestamp, x.at); }
            ev = s.events.recv() => match ev {
                Some(PeerEvent::State(RTCPeerConnectionState::Connected)) if connect_ms.is_none() => {
                    connect_ms = Some(s.started.elapsed().as_secs_f64() * 1000.0);
                    measure_until = Some(Instant::now() + Duration::from_secs(seconds));
                }
                Some(PeerEvent::State(RTCPeerConnectionState::Failed)) => panic!("ICE failed"),
                Some(PeerEvent::Unit(u)) => {
                    while let Ok(x) = sent_rx.try_recv() { sent.insert(x.rtp_timestamp, x.at); }
                    first_key.get_or_insert(u.key);
                    bytes += u.data.len();
                    if let Some(at) = sent.get(&u.rtp_timestamp) {
                        latencies.push((u.at - *at).as_secs_f64() * 1000.0);
                        if let Some(m) = u.marker_at {
                            net_latencies.push((m - *at).as_secs_f64() * 1000.0);
                        }
                    }
                    arrivals.push(u.at);
                }
                Some(_) => {}
                None => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
    let mut gaps: Vec<f64> = arrivals
        .windows(2)
        .map(|w| (w[1] - w[0]).as_secs_f64() * 1000.0)
        .collect();
    gaps.sort_by(f64::total_cmp);
    latencies.sort_by(f64::total_cmp);
    net_latencies.sort_by(f64::total_cmp);
    let span = match (arrivals.first(), arrivals.last()) {
        (Some(a), Some(b)) if b > a => (*b - *a).as_secs_f64(),
        _ => f64::NAN,
    };
    let last_stats = s.lines().into_iter().rev().find_map(|l| match l {
        Out::Stats(st) => Some(st),
        _ => None,
    });
    let summary = serde_json::json!({
        "ice": format!("{mode:?}"),
        "keyframeRequestsRelayed": relayed,
        "connectMs": connect_ms,
        "units": arrivals.len(),
        "fps": (arrivals.len().saturating_sub(1)) as f64 / span,
        "mbps": bytes as f64 * 8.0 / span / 1e6,
        "firstUnitKey": first_key,
        "netLatencyMs": {"p50": pct(&net_latencies, 50), "p95": pct(&net_latencies, 95), "max": net_latencies.last()},
        "assembledLatencyMs": {"p50": pct(&latencies, 50), "p95": pct(&latencies, 95), "max": latencies.last()},
        "gapMs": {"p50": pct(&gaps, 50), "p95": pct(&gaps, 95), "max": gaps.last()},
        "publisherStats": last_stats,
    });
    println!("{summary}");
    s.publisher.close().await;
    s.peer.close().await;
}
