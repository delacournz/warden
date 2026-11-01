//! The native stream path: WebRTC received in Rust (webrtc-rs), H264 reassembled per RTP
//! timestamp (`h264.rs`), and each access unit handed to the webview over a Tauri `Channel` for
//! WebCodecs to decode. WebKit's own receiver never assembles a frame of Revyl's stream (it splits
//! SPS/PPS into a separate same-timestamp frame), so on WebKit the webview's RTCPeerConnection is
//! not used at all. Signalling is the same non-trickle WHEP POST as the webview path.

use crate::device::{close_resource, fetch_ice_servers, post_offer, ApiError, IceServer};
use crate::h264::Assembler;
use crate::registry::Registry;
use crate::reorder::{Packet, Reorder};
use rtc::interceptor::Registry as InterceptorRegistry;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::{MediaEngine, MIME_TYPE_H264};
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use rtc::peer_connection::configuration::{RTCConfigurationBuilder, RTCIceServer};
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::rtp_sender::{
    RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RtpCodecKind,
};
use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, Response};
use tauri::State;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState,
    RTCPeerConnectionState,
};
use webrtc::runtime::{channel as rt_channel, Sender};

type CmdResult<T> = Result<T, ApiError>;

const GATHER_TIMEOUT: Duration = Duration::from_secs(2);
const PLI_EVERY: Duration = Duration::from_millis(500);
const STATS_EVERY: Duration = Duration::from_secs(5);
/// How long a sequence gap may wait for its packet (a retransmission) before it counts as loss.
const REORDER_WAIT_MS: u64 = 200;
/// The default 64-packet SRTP replay window throws away the late half of a reordered ~400-packet
/// keyframe as "duplicated", so no keyframe ever completes. Wide enough for a whole keyframe.
const SRTP_REPLAY_WINDOW: usize = 4096;
/// Packets held while waiting; a 1320x2868 keyframe is ~400.
const REORDER_CAPACITY: usize = 2048;

#[derive(Default)]
struct Stats {
    units: u64,
    keys: u64,
    plis: u64,
}

/// Message kinds on the channel: the first byte of every message.
pub const KIND_DELTA: u8 = 0;
pub const KIND_KEY: u8 = 1;
pub const KIND_STATE: u8 = 2;

/// `[kind u8][rtp timestamp u32 BE][body]`: an Annex-B access unit, or a UTF-8 state name.
pub fn frame_message(kind: u8, timestamp: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + body.len());
    out.push(kind);
    out.extend_from_slice(&timestamp.to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// The live native peer connection of each window, by label.
#[derive(Default)]
pub struct NativeStreams {
    peers: Mutex<HashMap<String, Arc<dyn PeerConnection>>>,
}

impl NativeStreams {
    fn replace(
        &self,
        label: &str,
        pc: Option<Arc<dyn PeerConnection>>,
    ) -> Option<Arc<dyn PeerConnection>> {
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        match pc {
            Some(pc) => peers.insert(label.to_owned(), pc),
            None => peers.remove(label),
        }
    }
}

/// Servers for the peer configuration; an absent username or credential is the empty string.
fn rtc_ice_servers(servers: Vec<IceServer>) -> Vec<RTCIceServer> {
    servers
        .into_iter()
        .map(|s| RTCIceServer {
            urls: s.urls,
            username: s.username.unwrap_or_default(),
            credential: s.credential.unwrap_or_default(),
        })
        .collect()
}

fn rtc_error(e: impl std::fmt::Display) -> ApiError {
    ApiError::new("STREAM", e.to_string())
}

struct Handler {
    channel: Channel<Response>,
    gathered: Sender<()>,
}

impl Handler {
    fn send(&self, message: Vec<u8>) -> bool {
        self.channel.send(Response::new(message)).is_ok()
    }

    fn state(&self, name: &str) {
        self.send(frame_message(KIND_STATE, 0, name.as_bytes()));
    }
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        log::info!("native stream: connection {state}");
        self.state(&state.to_string());
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let Some(&media_ssrc) = track.ssrcs().await.first() else {
            return;
        };
        let channel = self.channel.clone();
        tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let mut reorder = Reorder::new(REORDER_WAIT_MS, REORDER_CAPACITY);
            let mut assembler = Assembler::new();
            let mut last_pli: Option<Instant> = None;
            let mut stats = Stats::default();
            let mut last_report = Instant::now();
            while let Some(event) = track.poll().await {
                let TrackRemoteEvent::OnRtpPacket(packet) = event else {
                    continue;
                };
                let now_ms = started.elapsed().as_millis() as u64;
                let ordered = reorder.push(
                    Packet {
                        seq: packet.header.sequence_number,
                        timestamp: packet.header.timestamp,
                        payload: packet.payload.to_vec(),
                    },
                    now_ms,
                );
                let mut want_key = false;
                for p in ordered {
                    let pushed = assembler.push(p.seq, p.timestamp, &p.payload);
                    want_key |= pushed.request_keyframe;
                    for unit in pushed.units {
                        stats.units += 1;
                        stats.keys += u64::from(unit.key);
                        let kind = if unit.key { KIND_KEY } else { KIND_DELTA };
                        let message = frame_message(kind, unit.timestamp, &unit.data);
                        if channel.send(Response::new(message)).is_err() {
                            return; // the window is gone
                        }
                    }
                }
                if want_key && last_pli.is_none_or(|t| t.elapsed() >= PLI_EVERY) {
                    last_pli = Some(Instant::now());
                    stats.plis += 1;
                    let pli = PictureLossIndication {
                        sender_ssrc: 0,
                        media_ssrc,
                    };
                    if let Err(e) = track.write_rtcp(vec![Box::new(pli)]).await {
                        log::warn!("native stream: PLI failed: {e}");
                    }
                }
                if last_report.elapsed() >= STATS_EVERY {
                    log::info!(
                        "native stream: {} frames ({} key), {} PLIs in the last {}s",
                        stats.units,
                        stats.keys,
                        stats.plis,
                        STATS_EVERY.as_secs()
                    );
                    stats = Stats::default();
                    last_report = Instant::now();
                }
            }
        });
    }
}

fn media_engine() -> CmdResult<MediaEngine> {
    let mut engine = MediaEngine::default();
    let feedback = |typ: &str, parameter: &str| RTCPFeedback {
        typ: typ.to_owned(),
        parameter: parameter.to_owned(),
    };
    let h264 = RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                .to_owned(),
            rtcp_feedback: vec![feedback("nack", ""), feedback("nack", "pli")],
        },
        payload_type: 98,
    };
    engine
        .register_codec(h264, RtpCodecKind::Video)
        .map_err(rtc_error)?;
    Ok(engine)
}

/// Start (or restart) this window's native stream; frames and state arrive on `channel`.
#[tauri::command]
pub async fn native_stream_start(
    channel: Channel<Response>,
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
    streams: State<'_, Arc<NativeStreams>>,
) -> CmdResult<()> {
    let label = window.label().to_owned();
    if let Some(old) = streams.replace(&label, None) {
        let _ = old.close().await;
    }

    let ice_servers = rtc_ice_servers(fetch_ice_servers(&registry, &label).await);
    let mut engine = media_engine()?;
    let interceptors = register_default_interceptors(InterceptorRegistry::new(), &mut engine)
        .map_err(rtc_error)?;
    let (gathered, mut gathered_rx) = rt_channel::<()>(1);
    let handler = Arc::new(Handler { channel, gathered });
    let pc = PeerConnectionBuilder::new()
        .with_configuration(
            RTCConfigurationBuilder::new()
                .with_ice_servers(ice_servers)
                .build(),
        )
        .with_media_engine(engine)
        .with_setting_engine(
            SettingEngineBuilder::new()
                .with_srtp_replay_protection_window(SRTP_REPLAY_WINDOW)
                .build(),
        )
        .with_interceptor_registry(interceptors)
        .with_handler(handler.clone() as Arc<dyn PeerConnectionEventHandler>)
        .with_udp_addrs(vec!["0.0.0.0:0".to_owned()])
        .build()
        .await
        .map_err(rtc_error)?;
    let pc: Arc<dyn PeerConnection> = Arc::new(pc);
    streams.replace(&label, Some(pc.clone()));

    pc.add_transceiver_from_kind(
        RtpCodecKind::Video,
        Some(RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Recvonly,
            ..Default::default()
        }),
    )
    .await
    .map_err(rtc_error)?;

    let offer = pc.create_offer(None).await.map_err(rtc_error)?;
    pc.set_local_description(offer).await.map_err(rtc_error)?;
    let _ = tokio::time::timeout(GATHER_TIMEOUT, gathered_rx.recv()).await;
    let local = pc
        .local_description()
        .await
        .ok_or_else(|| ApiError::new("STREAM", "no local description"))?;

    let answer = post_offer(&registry, &label, local.sdp).await?;
    let answer = RTCSessionDescription::answer(answer).map_err(rtc_error)?;
    pc.set_remote_description(answer).await.map_err(rtc_error)?;
    handler.state("negotiated");
    Ok(())
}

/// Close this window's native stream and its WHEP resource.
#[tauri::command]
pub async fn native_stream_stop(
    window: tauri::WebviewWindow,
    registry: State<'_, Arc<Registry>>,
    streams: State<'_, Arc<NativeStreams>>,
) -> CmdResult<()> {
    if let Some(pc) = streams.replace(window.label(), None) {
        let _ = pc.close().await;
    }
    close_resource(&registry, window.label()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ice_servers_with_empty_defaults() {
        let mapped = rtc_ice_servers(vec![
            IceServer {
                urls: vec!["stun:s".into()],
                username: None,
                credential: None,
            },
            IceServer {
                urls: vec!["turn:t".into()],
                username: Some("u".into()),
                credential: Some("c".into()),
            },
        ]);
        assert_eq!(mapped[0].username, "");
        assert_eq!(mapped[1].credential, "c");
        assert!(rtc_ice_servers(vec![]).is_empty());
    }

    #[test]
    fn frames_kind_timestamp_then_body() {
        assert_eq!(
            frame_message(KIND_KEY, 0x0102_0304, &[9, 8]),
            vec![1, 1, 2, 3, 4, 9, 8]
        );
        assert_eq!(
            frame_message(KIND_STATE, 0, b"ok"),
            vec![2, 0, 0, 0, 0, b'o', b'k']
        );
    }
}
