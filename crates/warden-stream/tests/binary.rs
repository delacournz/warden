//! The `warden-stream` binary driven over its real stdin/stdout by the test peer.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use warden_stream::ice::IceMode;
use warden_stream::signal::{In, Out};
use warden_stream::testpeer::{PeerEvent, TestPeer};
use webrtc::peer_connection::RTCPeerConnectionState;

fn bin() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_warden-stream"));
    c.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    c
}

fn fixture() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fixture.h264")
        .display()
        .to_string()
}

async fn stdout_lines(args: &[&str]) -> (i32, Vec<String>) {
    let out = bin().args(args).output().await.unwrap();
    let lines = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    (out.status.code().unwrap_or(-1), lines)
}

#[tokio::test]
async fn usage_and_unsupported_errors_are_one_error_line_and_exit_2() {
    let (code, lines) = stdout_lines(&["--au-socket", "/x", "--bogus"]).await;
    assert_eq!(code, 2);
    assert_eq!(lines.len(), 1);
    assert!(
        matches!(serde_json::from_str::<Out>(&lines[0]).unwrap(), Out::Error { code, .. } if code == "USAGE")
    );

    let (code, lines) = stdout_lines(&["--au-socket", "/x", "--whip", "https://sfu/whip"]).await;
    assert_eq!(code, 2);
    assert!(
        matches!(serde_json::from_str::<Out>(&lines[0]).unwrap(), Out::Error { code, .. } if code == "UNSUPPORTED")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_binary_streams_to_a_peer_over_stdio_and_exits_0_on_close() {
    let mut child = bin()
        .args([
            "--au-file",
            &fixture(),
            "--loop",
            "--ice",
            "lan",
            "--udp-addr",
            "127.0.0.1:0",
        ])
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    // From the offer line, not the spawn: macOS scans a freshly linked binary on its first exec.
    let mut offered: Option<Instant> = None;

    let udp = ["127.0.0.1:0".parse().unwrap()];
    let (peer, mut events) = TestPeer::new(IceMode::Lan, &[], &udp).await.unwrap();
    let (to_bin, mut to_bin_rx) = mpsc::unbounded_channel::<In>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = to_bin_rx.recv().await {
            let line = serde_json::to_string(&msg).unwrap() + "\n";
            if stdin.write_all(line.as_bytes()).await.is_err() {
                return;
            }
        }
    });

    let mut connected_at = None;
    let mut units = 0;
    let mut first_key = None;
    let mut saw_stats = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !(units >= 60 && saw_stats) {
        assert!(
            Instant::now() < deadline,
            "units {units}, stats {saw_stats}"
        );
        tokio::select! {
            line = stdout.next_line() => {
                let line = line.unwrap().expect("stdout open");
                let out: Out = serde_json::from_str(&line).unwrap_or_else(|e| panic!("{line}: {e}"));
                saw_stats |= matches!(out, Out::Stats(_));
                if matches!(out, Out::Offer { .. }) {
                    offered = Some(Instant::now());
                }
                peer.handle(&out, &to_bin).await.unwrap();
            }
            Some(event) = events.recv() => match event {
                PeerEvent::Signal(msg) => { let _ = to_bin.send(msg); }
                PeerEvent::State(RTCPeerConnectionState::Connected) => {
                    connected_at = offered.map(|t| t.elapsed());
                }
                PeerEvent::Unit(u) => {
                    first_key.get_or_insert(u.key);
                    units += 1;
                }
                _ => {}
            },
        }
    }
    let connected_at = connected_at.expect("connected");
    eprintln!("binary: connected {connected_at:?} after the offer line");
    assert!(connected_at < Duration::from_secs(1));
    assert_eq!(first_key, Some(true));

    to_bin.send(In::Close).unwrap();
    let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .expect("exits after close")
        .unwrap();
    assert!(status.success(), "{status:?}");
    writer.abort();
    peer.close().await;
}
