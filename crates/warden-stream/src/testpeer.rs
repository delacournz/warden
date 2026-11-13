//! A receiving peer for tests and the live bench: answers the publisher's offer, trickles its own
//! candidates, reassembles the H.264 with [`warden_rtc::h264::Assembler`] and reports each access
//! unit with its arrival time. It sends a PLI whenever the assembler asks for a keyframe, like the
//! viewer does. Not used by the `warden-stream` binary.

use crate::ice::{self, IceMode, IceServer};
use crate::signal::{Candidate, In, Out};
use rtc::interceptor::Registry;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::MediaEngine;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::RTCIceCandidateInit;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::rtp_sender::{RTCRtpCodecParameters, RtpCodecKind};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::mpsc;
use warden_rtc::codec;
use warden_rtc::h264::Assembler;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState,
    RTCPeerConnectionIceEvent, RTCPeerConnectionState,
};

/// The data channels the publisher opened, by label.
type Channels = Arc<Mutex<Vec<(String, Arc<dyn DataChannel>)>>>;

#[derive(Debug, Clone)]
pub struct Received {
    pub rtp_timestamp: u32,
    pub key: bool,
    pub data: Vec<u8>,
    /// When the assembler released it: the arrival of the next unit's first packet, since it
    /// groups by timestamp (so this trails the network by up to one frame interval).
    pub at: Instant,
    /// When its last (marker) packet arrived: the network arrival time.
    pub marker_at: Option<Instant>,
}

/// What the peer reports, in order.
#[derive(Debug, Clone)]
pub enum PeerEvent {
    /// A line for the publisher's stdin.
    Signal(In),
    State(RTCPeerConnectionState),
    Unit(Received),
    /// A data channel opened; send on it with [`TestPeer::send`].
    ChannelOpen(String),
}

struct Handler {
    events: mpsc::UnboundedSender<PeerEvent>,
    channels: Channels,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(init) = event.candidate.to_json() {
            let _ = self.events.send(PeerEvent::Signal(In::Candidate(Candidate {
                candidate: init.candidate,
                sdp_mid: init.sdp_mid,
                sdp_mline_index: init.sdp_mline_index,
            })));
        }
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.events.send(PeerEvent::Signal(In::EndOfCandidates));
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.events.send(PeerEvent::State(state));
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let events = self.events.clone();
        let channels = self.channels.clone();
        tokio::spawn(async move {
            let label = dc.label().await.unwrap_or_default();
            while let Some(event) = dc.poll().await {
                match event {
                    DataChannelEvent::OnOpen => {
                        channels
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push((label.clone(), dc.clone()));
                        let _ = events.send(PeerEvent::ChannelOpen(label.clone()));
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
        });
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let Some(&media_ssrc) = track.ssrcs().await.first() else {
            return;
        };
        let events = self.events.clone();
        tokio::spawn(async move {
            let mut assembler = Assembler::new();
            let mut last_pli: Option<Instant> = None;
            let mut markers: std::collections::VecDeque<(u32, Instant)> = Default::default();
            while let Some(event) = track.poll().await {
                let TrackRemoteEvent::OnRtpPacket(packet) = event else {
                    continue;
                };
                if packet.header.marker {
                    markers.push_back((packet.header.timestamp, Instant::now()));
                    if markers.len() > 64 {
                        markers.pop_front();
                    }
                }
                let pushed = assembler.push(
                    packet.header.sequence_number,
                    packet.header.timestamp,
                    &packet.payload,
                );
                let at = Instant::now();
                for unit in pushed.units {
                    let _ = events.send(PeerEvent::Unit(Received {
                        rtp_timestamp: unit.timestamp,
                        key: unit.key,
                        data: unit.data,
                        at,
                        marker_at: markers
                            .iter()
                            .find(|(ts, _)| *ts == unit.timestamp)
                            .map(|(_, t)| *t),
                    }));
                }
                if pushed.request_keyframe
                    && last_pli.is_none_or(|t| t.elapsed().as_millis() >= 500)
                {
                    last_pli = Some(Instant::now());
                    let pli = PictureLossIndication {
                        sender_ssrc: 0,
                        media_ssrc,
                    };
                    let _ = track.write_rtcp(vec![Box::new(pli)]).await;
                }
            }
        });
    }
}

pub struct TestPeer {
    pc: Arc<dyn PeerConnection>,
    channels: Channels,
}

impl TestPeer {
    pub async fn new(
        mode: IceMode,
        servers: &[IceServer],
        udp_addrs: &[SocketAddr],
    ) -> Result<(Self, mpsc::UnboundedReceiver<PeerEvent>), String> {
        let mut engine = MediaEngine::default();
        engine
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: codec::h264(codec::receiver_feedback()),
                    payload_type: 102,
                },
                RtpCodecKind::Video,
            )
            .map_err(|e| e.to_string())?;
        let registry = register_default_interceptors(Registry::new(), &mut engine)
            .map_err(|e| e.to_string())?;
        let (events, rx) = mpsc::unbounded_channel();
        let channels = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(Handler {
            events,
            channels: channels.clone(),
        });
        let pc = PeerConnectionBuilder::new()
            .with_configuration(
                RTCConfigurationBuilder::new()
                    .with_ice_servers(ice::ice_servers(mode, servers)?)
                    .with_ice_transport_policy(ice::transport_policy(mode))
                    .build(),
            )
            .with_media_engine(engine)
            .with_setting_engine(ice::setting_engine(mode))
            .with_interceptor_registry(registry)
            .with_handler(handler as Arc<dyn PeerConnectionEventHandler>)
            .with_udp_addrs(ice::udp_bind_addrs(&ice::local_ifaces(), udp_addrs))
            .build()
            .await
            .map_err(|e| e.to_string())?;
        Ok((
            Self {
                pc: Arc::new(pc),
                channels,
            },
            rx,
        ))
    }

    /// Apply one publisher stdout line; an offer is answered at once (the answer comes back as a
    /// [`PeerEvent::Signal`] line, ahead of this peer's candidates).
    pub async fn handle(
        &self,
        out: &Out,
        events: &mpsc::UnboundedSender<In>,
    ) -> Result<(), String> {
        match out {
            Out::Offer { sdp } => {
                let offer = RTCSessionDescription::offer(sdp.clone()).map_err(|e| e.to_string())?;
                self.pc
                    .set_remote_description(offer)
                    .await
                    .map_err(|e| e.to_string())?;
                let answer = self
                    .pc
                    .create_answer(None)
                    .await
                    .map_err(|e| e.to_string())?;
                let _ = events.send(In::Answer {
                    sdp: answer.sdp.clone(),
                });
                self.pc
                    .set_local_description(answer)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            Out::Candidate(c) => self
                .pc
                .add_ice_candidate(RTCIceCandidateInit {
                    candidate: c.candidate.clone(),
                    sdp_mid: c.sdp_mid.clone(),
                    sdp_mline_index: c.sdp_mline_index,
                    ..Default::default()
                })
                .await
                .map_err(|e| e.to_string()),
            _ => Ok(()),
        }
    }

    /// Send a text message on a data channel the publisher opened.
    pub async fn send(&self, label: &str, text: &str) -> Result<(), String> {
        let dc = self
            .channels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(l, _)| l == label)
            .map(|(_, dc)| dc.clone())
            .ok_or_else(|| format!("no open channel {label}"))?;
        dc.send_text(text).await.map_err(|e| e.to_string())
    }

    /// Ask the publisher for a keyframe (RTCP PLI on the received track).
    pub async fn pli(&self) -> Result<(), String> {
        for receiver in self.pc.get_receivers().await {
            let track = receiver.track();
            let Some(&media_ssrc) = track.ssrcs().await.first() else {
                continue;
            };
            let pli = PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc,
            };
            return track
                .write_rtcp(vec![Box::new(pli)])
                .await
                .map_err(|e| e.to_string());
        }
        Err("no receiving track".to_owned())
    }

    pub async fn close(&self) {
        let _ = self.pc.close().await;
    }
}

/// A publisher and a [`TestPeer`] wired together the way a caller wires them: every signalling
/// message goes through its NDJSON line (`Out::line` → parse, `In` → line → `In::parse`), trickle
/// on both sides.
pub struct Session {
    pub publisher: Arc<crate::publisher::Publisher>,
    pub peer: Arc<TestPeer>,
    /// Every publisher stdout line so far, parsed back.
    pub lines: Arc<Mutex<Vec<Out>>>,
    /// The peer's non-signalling events: state, units, open channels.
    pub events: mpsc::UnboundedReceiver<PeerEvent>,
    pub started: Instant,
}

pub struct PeerSide<'a> {
    pub mode: IceMode,
    pub servers: &'a [IceServer],
    pub udp_addrs: &'a [SocketAddr],
}

impl Session {
    pub async fn start(
        config: crate::publisher::Config,
        source: crate::source::Source,
        peer: PeerSide<'_>,
        sent: Option<mpsc::UnboundedSender<crate::publisher::Sent>>,
    ) -> Result<Self, String> {
        let (peer, mut peer_rx) = TestPeer::new(peer.mode, peer.servers, peer.udp_addrs).await?;
        let peer = Arc::new(peer);
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
        let (in_tx, mut in_rx) = mpsc::unbounded_channel::<In>();
        let (events_tx, events) = mpsc::unbounded_channel();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let started = Instant::now();
        let publisher = crate::publisher::Publisher::start(config, source, out_tx, sent).await?;

        let (to_peer, recorded, answers) = (peer.clone(), lines.clone(), in_tx.clone());
        tokio::spawn(async move {
            while let Some(out) = out_rx.recv().await {
                let line = out.line();
                let Ok(parsed) = serde_json::from_str::<Out>(&line) else {
                    panic!("unparseable stdout line {line}");
                };
                recorded
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(parsed.clone());
                if let Err(e) = to_peer.handle(&parsed, &answers).await {
                    log::warn!("test peer: {e}");
                }
            }
        });
        let to_publisher = publisher.clone();
        tokio::spawn(async move {
            while let Some(msg) = in_rx.recv().await {
                let line = serde_json::to_string(&msg).unwrap_or_default();
                match In::parse(&line) {
                    Ok(parsed) => {
                        if let Err(e) = to_publisher.handle(parsed).await {
                            log::warn!("publisher: {e}");
                        }
                    }
                    Err(e) => panic!("unparseable stdin line {line}: {e}"),
                }
            }
        });
        tokio::spawn(async move {
            while let Some(event) = peer_rx.recv().await {
                match event {
                    PeerEvent::Signal(msg) => {
                        let _ = in_tx.send(msg);
                    }
                    other => {
                        let _ = events_tx.send(other);
                    }
                }
            }
        });
        Ok(Self {
            publisher,
            peer,
            lines,
            events,
            started,
        })
    }

    pub fn lines(&self) -> Vec<Out> {
        self.lines.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
