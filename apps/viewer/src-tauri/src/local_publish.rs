//! Re-publishes the native stream to the webview as a spec-compliant local WebRTC stream.
//!
//! `native_stream.rs` receives Revyl's H264 and reassembles one access unit per RTP timestamp.
//! Here each access unit is packetized again (RFC 6184: one timestamp per access unit, SPS/PPS in a
//! STAP-A ahead of the IDR, marker on the last packet only) and sent over a loopback peer
//! connection to the webview's own `RTCPeerConnection`, which decodes it in hardware into a
//! `<video>`. Revyl's RTP timestamps are kept as they are, so frame timing survives drops.
//!
//! Signalling is in-process and non-trickle: the webview's recvonly offer goes to
//! `local_stream_answer`, which returns the answer with every candidate.

use crate::device::ApiError;
use rtc::interceptor::Registry as InterceptorRegistry;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::MediaEngine;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use warden_rtc::codec;
use warden_rtc::packetize::Packetizer;
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState,
    RTCPeerConnectionState,
};
use webrtc::runtime::{channel as rt_channel, Sender};

const GATHER_TIMEOUT: Duration = Duration::from_secs(2);
/// Loopback only: the stream never leaves the machine.
const UDP_ADDRS: [&str; 1] = ["127.0.0.1:0"];

fn rtc_error(e: impl std::fmt::Display) -> ApiError {
    ApiError::new("STREAM", e.to_string())
}

fn h264_codec() -> RTCRtpCodec {
    codec::h264(vec![])
}

/// One window's loopback sender.
pub struct LocalPublisher {
    pc: Arc<dyn PeerConnection>,
    track: Arc<TrackLocalStaticRTP>,
    ssrc: u32,
    payload_type: u8,
    packetizer: Mutex<Packetizer>,
}

impl LocalPublisher {
    /// Send one access unit. Units written before the webview connects are dropped.
    pub async fn write(&self, timestamp: u32, annexb: &[u8]) {
        let packets = self
            .packetizer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .packets(self.ssrc, self.payload_type, timestamp, annexb);
        for packet in packets {
            if self.track.write_rtp(packet).await.is_err() {
                return;
            }
        }
    }

    pub async fn close(&self) {
        let _ = self.pc.close().await;
    }
}

/// Where the native receiver hands its access units: the window's current publisher, if any, and
/// whether a fresh keyframe is wanted upstream (a webview just connected and needs one to start).
#[derive(Default)]
pub struct Outlet {
    publisher: Mutex<Option<Arc<LocalPublisher>>>,
    want_key: AtomicBool,
}

impl Outlet {
    pub fn publisher(&self) -> Option<Arc<LocalPublisher>> {
        self.publisher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Install `next`, returning the one it replaces.
    pub fn replace(&self, next: Option<Arc<LocalPublisher>>) -> Option<Arc<LocalPublisher>> {
        std::mem::replace(
            &mut *self.publisher.lock().unwrap_or_else(|e| e.into_inner()),
            next,
        )
    }

    pub fn request_keyframe(&self) {
        self.want_key.store(true, Ordering::Relaxed);
    }

    /// True once per request.
    pub fn take_keyframe_request(&self) -> bool {
        self.want_key.swap(false, Ordering::Relaxed)
    }
}

struct Handler {
    outlet: Arc<Outlet>,
    gathered: Sender<()>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        log::info!("local stream: connection {state}");
        if state == RTCPeerConnectionState::Connected {
            self.outlet.request_keyframe();
        }
    }
}

/// Answer the webview's recvonly `offer` with a new loopback publisher on `outlet`.
pub async fn answer(
    outlet: Arc<Outlet>,
    offer: String,
) -> Result<(String, Arc<LocalPublisher>), ApiError> {
    let mut engine = MediaEngine::default();
    engine
        .register_codec(
            RTCRtpCodecParameters {
                rtp_codec: h264_codec(),
                payload_type: 102,
            },
            RtpCodecKind::Video,
        )
        .map_err(rtc_error)?;
    let interceptors = register_default_interceptors(InterceptorRegistry::new(), &mut engine)
        .map_err(rtc_error)?;
    let (gathered, mut gathered_rx) = rt_channel::<()>(1);
    let handler = Arc::new(Handler { outlet, gathered });
    let pc = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(engine)
        .with_interceptor_registry(interceptors)
        .with_handler(handler as Arc<dyn PeerConnectionEventHandler>)
        .with_udp_addrs(UDP_ADDRS.iter().map(|a| (*a).to_owned()).collect())
        .build()
        .await
        .map_err(rtc_error)?;
    let pc: Arc<dyn PeerConnection> = Arc::new(pc);

    let ssrc = rand_u32();
    let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
        "warden".to_owned(),
        "warden-video".to_owned(),
        "warden-video".to_owned(),
        RtpCodecKind::Video,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(ssrc),
                ..Default::default()
            },
            codec: h264_codec(),
            ..Default::default()
        }],
    )));
    let negotiate = async {
        let sender = pc
            .add_track(track.clone() as Arc<dyn TrackLocal>)
            .await
            .map_err(rtc_error)?;
        let offer = RTCSessionDescription::offer(offer).map_err(rtc_error)?;
        pc.set_remote_description(offer).await.map_err(rtc_error)?;
        let answer = pc.create_answer(None).await.map_err(rtc_error)?;
        pc.set_local_description(answer).await.map_err(rtc_error)?;
        let _ = tokio::time::timeout(GATHER_TIMEOUT, gathered_rx.recv()).await;
        let local = pc
            .local_description()
            .await
            .ok_or_else(|| ApiError::new("STREAM", "no local description"))?;
        let payload_type = sender
            .get_parameters()
            .await
            .map_err(rtc_error)?
            .rtp_parameters
            .codecs
            .first()
            .map(|c| c.payload_type)
            .ok_or_else(|| ApiError::new("STREAM", "the webview offered no H264 decoder"))?;
        Ok::<_, ApiError>((local.sdp, payload_type))
    };
    let (sdp, payload_type) = match negotiate.await {
        Ok(done) => done,
        Err(e) => {
            let _ = pc.close().await;
            return Err(e);
        }
    };
    let publisher = Arc::new(LocalPublisher {
        pc,
        track,
        ssrc,
        payload_type,
        packetizer: Mutex::new(Packetizer::new(rand_u32() as u16)),
    });
    Ok((sdp, publisher))
}

/// Not cryptographic: SSRC and first sequence number only need to differ between sessions.
fn rand_u32() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos() as u64),
    );
    h.finish() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_keyframe_request_is_taken_once() {
        let outlet = Outlet::default();
        assert!(!outlet.take_keyframe_request());
        outlet.request_keyframe();
        assert!(outlet.take_keyframe_request());
        assert!(!outlet.take_keyframe_request());
    }
}
