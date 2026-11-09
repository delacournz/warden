//! Publisher → in-process test peer over loopback: the committed fixture (120 Constrained Baseline
//! pictures, 320x640, one IDR) replayed at 60 fps, signalled through real NDJSON lines with
//! trickle ICE on both sides.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use warden_stream::framing::rtp_timestamp;
use warden_stream::ice::IceMode;
use warden_stream::publisher::Config;
use warden_stream::signal::{KeyframeReason, Out};
use warden_stream::source::{self, Spec};
use warden_stream::testpeer::{PeerEvent, PeerSide, Received, Session};
use webrtc::peer_connection::RTCPeerConnectionState;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fixture.h264")
}

fn loopback() -> Vec<SocketAddr> {
    vec!["127.0.0.1:0".parse().unwrap()]
}

async fn session(looped: bool) -> Session {
    let udp = loopback();
    let config = Config {
        ice: IceMode::Lan,
        udp_addrs: udp.clone(),
        ..Config::default()
    };
    let source = source::start(Spec::File {
        path: fixture(),
        fps: 60.0,
        looped,
    });
    Session::start(
        config,
        source,
        PeerSide {
            mode: IceMode::Lan,
            servers: &[],
            udp_addrs: &udp,
        },
        None,
    )
    .await
    .expect("session")
}

/// Wait for the peer to report connected; returns how long it took from the session start.
async fn connected(s: &mut Session) -> Duration {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, s.events.recv()).await {
            Ok(Some(PeerEvent::State(RTCPeerConnectionState::Connected))) => {
                return s.started.elapsed()
            }
            Ok(Some(PeerEvent::State(RTCPeerConnectionState::Failed))) => panic!("ICE failed"),
            Ok(Some(_)) => {}
            _ => panic!("not connected within 10 s; lines: {:?}", s.lines()),
        }
    }
}

async fn wait_for(s: &Session, what: &str, f: impl Fn(&Out) -> bool) -> Out {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(found) = s.lines().into_iter().find(|l| f(l)) {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "no {what} line in {:?}",
            s.lines()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_fixture_arrives_whole_at_60_fps_starting_on_a_keyframe() {
    let mut s = session(false).await;
    let connect = connected(&mut s).await;
    assert!(
        connect < Duration::from_secs(1),
        "connected in {connect:?}, want < 1 s"
    );

    let expected = source::load_units(&std::fs::read(fixture()).unwrap(), 60.0).unwrap();
    let mut got: Vec<Received> = Vec::new();
    // The assembler emits a unit when the next one starts, so the last one stays pending: 119 of 120.
    let want = expected.len() - 1;
    let deadline = Instant::now() + Duration::from_secs(8);
    while got.len() < want {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, s.events.recv()).await {
            Ok(Some(PeerEvent::Unit(u))) => got.push(u),
            Ok(Some(_)) => {}
            _ => panic!("received {} of {want} units", got.len()),
        }
    }

    assert!(got[0].key, "the first unit received is a keyframe");
    for (i, (r, e)) in got.iter().zip(&expected).enumerate() {
        assert_eq!(
            r.rtp_timestamp,
            rtp_timestamp(e.pts_us),
            "unit {i} timestamp"
        );
        assert_eq!(r.data, e.data, "unit {i} is byte-identical");
        assert_eq!(r.key, e.key(), "unit {i} key flag");
    }

    let span = got.last().unwrap().at - got[0].at;
    let fps = (got.len() - 1) as f64 / span.as_secs_f64();
    let mut gaps: Vec<f64> = got
        .windows(2)
        .map(|w| (w[1].at - w[0].at).as_secs_f64() * 1000.0)
        .collect();
    gaps.sort_by(f64::total_cmp);
    let p50 = gaps[gaps.len() / 2];
    let p95 = gaps[gaps.len() * 95 / 100];
    eprintln!(
        "loopback: connected in {connect:?}, {} units, {fps:.1} fps, gap p50 {p50:.1} ms p95 {p95:.1} ms",
        got.len()
    );
    assert!((55.0..=65.0).contains(&fps), "arrival rate {fps:.1} fps");
    assert!((14.0..=19.5).contains(&p50), "gap p50 {p50:.1} ms");

    let lines = s.lines();
    let offer_at = lines
        .iter()
        .position(|l| matches!(l, Out::Offer { .. }))
        .expect("offer");
    let first_candidate = lines
        .iter()
        .position(|l| matches!(l, Out::Candidate(_)))
        .expect("a trickled candidate");
    assert!(offer_at < first_candidate, "the offer leads its candidates");
    assert!(lines.iter().any(|l| matches!(l, Out::EndOfCandidates)));
    assert!(lines.iter().any(|l| matches!(
        l,
        Out::KeyframeRequest {
            reason: KeyframeReason::Connected
        }
    )));
    assert!(lines
        .iter()
        .any(|l| matches!(l, Out::State { state } if state == "connected")));

    s.publisher.close().await;
    s.peer.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn data_channel_messages_come_out_as_input_lines() {
    let mut s = session(true).await;
    connected(&mut s).await;
    let mut open = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while open.len() < 2 {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, s.events.recv()).await {
            Ok(Some(PeerEvent::ChannelOpen(label))) => open.push(label),
            Ok(Some(_)) => {}
            _ => panic!("channels open: {open:?}"),
        }
    }
    open.sort();
    assert_eq!(open, vec!["input".to_owned(), "input-moves".to_owned()]);

    let down = r#"{"type":"touch","phase":"down","x":0.5,"y":0.5}"#;
    let mv = r#"{"type":"touch","phase":"move","x":0.5,"y":0.6}"#;
    s.peer.send("input", down).await.unwrap();
    s.peer.send("input-moves", mv).await.unwrap();
    let got = wait_for(
        &s,
        "input",
        |l| matches!(l, Out::Input { channel, data } if channel == "input" && data == down),
    )
    .await;
    assert!(matches!(got, Out::Input { .. }));
    wait_for(
        &s,
        "input-moves",
        |l| matches!(l, Out::Input { channel, data } if channel == "input-moves" && data == mv),
    )
    .await;

    s.publisher.close().await;
    s.peer.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pli_becomes_a_keyframe_request_and_stats_tick_every_second() {
    let mut s = session(true).await;
    connected(&mut s).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.peer.pli().await.unwrap();
    wait_for(&s, "keyframe-request pli", |l| {
        matches!(
            l,
            Out::KeyframeRequest {
                reason: KeyframeReason::Pli
            }
        )
    })
    .await;

    tokio::time::sleep(Duration::from_millis(1500)).await;
    let stats: Vec<_> = s
        .lines()
        .into_iter()
        .filter_map(|l| match l {
            Out::Stats(st) => Some(st),
            _ => None,
        })
        .collect();
    let last = stats.last().expect("a stats line");
    eprintln!("stats: {last:?}");
    assert!(last.fps > 40.0, "fps {}", last.fps);
    assert!(last.bitrate > 0);
    assert!(last.units_sent > 60);
    assert!(last.plis >= 1);
    assert_eq!(last.path, Some(warden_stream::signal::PathKind::Host));
    assert_eq!(last.network, Some(warden_stream::signal::Network::Loopback));
    assert_eq!(last.relayed_bytes, 0);

    s.publisher.close().await;
    s.peer.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_close_line_closes_the_publisher() {
    let mut s = session(true).await;
    connected(&mut s).await;
    s.publisher
        .handle(warden_stream::signal::In::Close)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), s.publisher.closed())
        .await
        .expect("closed");
    s.peer.close().await;
}
