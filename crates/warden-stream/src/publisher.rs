//! The WebRTC side: one sendonly H.264 track and the `input` / `input-moves` data channels, offered
//! with trickle ICE, media held until the peer connection is connected.
//!
//! - The offer goes out as soon as the local description is set; every candidate follows as it is
//!   gathered (never a wait for gathering to finish), then `end-of-candidates`.
//! - Nothing is sent before `connected`: then a `keyframe-request` (`connected`) and deltas are
//!   skipped until a keyframe, so the first unit the peer sees is an IDR.
//! - PLI / FIR from the peer become `keyframe-request` (`pli`); NACKs are answered by the
//!   interceptor's retransmit buffer; a cut backlog becomes `keyframe-request` (`drop`).

use crate::framing::{rtp_timestamp, Unit};
use crate::ice::{self, IceMode, IceServer};
use crate::signal::{Candidate, In, KeyframeReason, Out};
use crate::source::{Source, SourceEvent};
use crate::stats::{self, Counters, Tracker};
use rtc::data_channel::RTCDataChannelInit;
use rtc::interceptor::{Attribute, Interceptor, Packet, Registry, Slot, StreamInfo, TaggedPacket};
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::MediaEngine;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::RTCIceCandidateInit;
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};
use rtc::sansio::Protocol;
use rtc::statistics::StatsSelector;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use warden_rtc::codec;
use warden_rtc::packetize::Packetizer;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState,
    RTCPeerConnectionIceEvent, RTCPeerConnectionState,
};

pub const PAYLOAD_TYPE: u8 = 102;
pub const INPUT: &str = "input";
pub const INPUT_MOVES: &str = "input-moves";
/// PLIs closer together than this ask for one keyframe: the encoder is already making it.
const PLI_COALESCE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone)]
pub struct Config {
    pub ice: IceMode,
    pub ice_servers: Vec<IceServer>,
    /// Explicit UDP binds (`--udp-addr`); empty means one per host interface address.
    pub udp_addrs: Vec<SocketAddr>,
    pub stats_every: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            ice: IceMode::Auto,
            ice_servers: Vec::new(),
            udp_addrs: Vec::new(),
            stats_every: Duration::from_secs(1),
        }
    }
}

/// When each unit was handed to the track, for latency measurement (tests, live bench).
#[derive(Debug, Clone, Copy)]
pub struct Sent {
    pub rtp_timestamp: u32,
    pub at: Instant,
}

/// Every `Out` line, in order. Candidates gathered before the offer is out wait behind it.
#[derive(Clone)]
struct Outbox {
    tx: mpsc::UnboundedSender<Out>,
    held: Arc<Mutex<Option<Vec<Out>>>>,
}

impl Outbox {
    fn new(tx: mpsc::UnboundedSender<Out>) -> Self {
        Self {
            tx,
            held: Arc::new(Mutex::new(Some(Vec::new()))),
        }
    }

    fn send(&self, out: Out) {
        let _ = self.tx.send(out);
    }

    /// A candidate or end-of-candidates: held until the offer has gone out.
    fn send_after_offer(&self, out: Out) {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        match held.as_mut() {
            Some(queue) => queue.push(out),
            None => self.send(out),
        }
    }

    fn offer(&self, sdp: String) {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        self.send(Out::Offer { sdp });
        for out in held.take().unwrap_or_default() {
            self.send(out);
        }
    }
}

struct Handler {
    outbox: Outbox,
    state: watch::Sender<RTCPeerConnectionState>,
    channels: mpsc::UnboundedSender<Arc<dyn DataChannel>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        match event.candidate.to_json() {
            Ok(init) => self.outbox.send_after_offer(Out::Candidate(Candidate {
                candidate: init.candidate,
                sdp_mid: init.sdp_mid,
                sdp_mline_index: init.sdp_mline_index,
            })),
            Err(e) => log::warn!("publisher: candidate not serializable: {e}"),
        }
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.outbox.send_after_offer(Out::EndOfCandidates);
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        log::info!("publisher: connection {state}");
        self.outbox.send(Out::State {
            state: state.to_string(),
        });
        let _ = self.state.send(state);
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let _ = self.channels.send(dc);
    }
}

/// Inbound keyframe requests (PLI, FIR) to the application; everything else stays with the
/// interceptors (NACKs to the responder, reports to the stats). Sits last in the chain.
#[derive(Default)]
struct KeyframeRequests {
    read: VecDeque<TaggedPacket>,
    write: VecDeque<TaggedPacket>,
}

fn is_keyframe_request(p: &dyn rtc::rtcp::Packet) -> bool {
    let any = p.as_any();
    any.is::<PictureLossIndication>() || any.is::<FullIntraRequest>()
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for KeyframeRequests {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = Instant;

    fn handle_read(&mut self, mut msg: TaggedPacket) -> Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &msg.message.packet {
            let requests: Vec<Box<dyn rtc::rtcp::Packet>> = packets
                .iter()
                .filter(|p| is_keyframe_request(p.as_ref()))
                .cloned()
                .collect();
            if requests.is_empty() {
                return Ok(());
            }
            msg.message.packet = Packet::Rtcp(requests);
            msg.message.add(Attribute::DeliverToApplication);
        }
        self.read.push_back(msg);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        self.write.push_back(msg);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write.pop_front()
    }
}

impl Interceptor for KeyframeRequests {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
}

#[derive(Default)]
struct Shared {
    units_sent: AtomicU64,
    rtp_bytes: AtomicU64,
    units_dropped: AtomicU64,
    plis: AtomicU64,
    closed: AtomicBool,
}

impl Shared {
    fn counters(&self) -> Counters {
        Counters {
            units_sent: self.units_sent.load(Ordering::Relaxed),
            rtp_bytes: self.rtp_bytes.load(Ordering::Relaxed),
            units_dropped: self.units_dropped.load(Ordering::Relaxed),
            plis: self.plis.load(Ordering::Relaxed),
        }
    }
}

pub struct Publisher {
    pc: Arc<dyn PeerConnection>,
    outbox: Outbox,
    shared: Arc<Shared>,
    /// Remote candidates that arrived before the answer.
    early: Mutex<Option<Vec<RTCIceCandidateInit>>>,
    done: watch::Sender<bool>,
}

fn rtc_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Not cryptographic: SSRC and the first sequence number only need to differ between sessions.
fn rand_u32() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    h.finish() as u32
}

impl Publisher {
    /// Build the peer connection, create the offer and start trickling. `out` receives every
    /// stdout line; `sent` (optional) the time each unit was written.
    pub async fn start(
        config: Config,
        source: Source,
        out: mpsc::UnboundedSender<Out>,
        sent: Option<mpsc::UnboundedSender<Sent>>,
    ) -> Result<Arc<Self>, String> {
        let servers = ice::ice_servers(config.ice, &config.ice_servers)?;
        let mut engine = MediaEngine::default();
        engine
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: codec::h264(codec::receiver_feedback()),
                    payload_type: PAYLOAD_TYPE,
                },
                RtpCodecKind::Video,
            )
            .map_err(rtc_err)?;
        let registry =
            register_default_interceptors(Registry::new(), &mut engine).map_err(rtc_err)?;
        let registry = registry.with(Slot::from(14_000), KeyframeRequests::default());

        let outbox = Outbox::new(out);
        let (state_tx, state_rx) = watch::channel(RTCPeerConnectionState::New);
        let (channels_tx, _channels_rx) = mpsc::unbounded_channel();
        let handler = Arc::new(Handler {
            outbox: outbox.clone(),
            state: state_tx,
            channels: channels_tx,
        });
        let udp = ice::udp_bind_addrs(&ice::local_ifaces(), &config.udp_addrs);
        let pc = PeerConnectionBuilder::new()
            .with_configuration(
                RTCConfigurationBuilder::new()
                    .with_ice_servers(servers)
                    .with_ice_transport_policy(ice::transport_policy(config.ice))
                    .build(),
            )
            .with_media_engine(engine)
            .with_setting_engine(ice::setting_engine(config.ice))
            .with_interceptor_registry(registry)
            .with_handler(handler as Arc<dyn PeerConnectionEventHandler>)
            .with_udp_addrs(udp)
            .build()
            .await
            .map_err(rtc_err)?;
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
                codec: codec::h264(codec::receiver_feedback()),
                ..Default::default()
            }],
        )));
        pc.add_transceiver_from_track(
            track.clone() as Arc<dyn TrackLocal>,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Sendonly,
                ..Default::default()
            }),
        )
        .await
        .map_err(rtc_err)?;

        let input = pc
            .create_data_channel(INPUT, Some(RTCDataChannelInit::default()))
            .await
            .map_err(rtc_err)?;
        let moves = pc
            .create_data_channel(
                INPUT_MOVES,
                Some(RTCDataChannelInit {
                    ordered: true,
                    max_retransmits: Some(0),
                    ..Default::default()
                }),
            )
            .await
            .map_err(rtc_err)?;

        let (done, _) = watch::channel(false);
        let publisher = Arc::new(Self {
            pc: pc.clone(),
            outbox: outbox.clone(),
            shared: Arc::new(Shared::default()),
            early: Mutex::new(Some(Vec::new())),
            done,
        });

        for dc in [input, moves] {
            tokio::spawn(forward_channel(dc, outbox.clone()));
        }
        let source = Arc::new(source);
        tokio::spawn(rtcp_loop(
            track.clone(),
            source.clone(),
            outbox.clone(),
            publisher.shared.clone(),
        ));
        tokio::spawn(media_loop(
            publisher.clone(),
            track,
            ssrc,
            source,
            state_rx.clone(),
            sent,
        ));
        tokio::spawn(stats_loop(publisher.clone(), config.stats_every));
        tokio::spawn(watch_failure(publisher.clone(), state_rx));

        let offer = pc.create_offer(None).await.map_err(rtc_err)?;
        pc.set_local_description(offer).await.map_err(rtc_err)?;
        let local = pc
            .local_description()
            .await
            .ok_or_else(|| "no local description".to_owned())?;
        outbox.offer(local.sdp);
        Ok(publisher)
    }

    /// Apply one stdin line.
    pub async fn handle(&self, msg: In) -> Result<(), String> {
        match msg {
            In::Answer { sdp } => {
                let answer = RTCSessionDescription::answer(sdp).map_err(rtc_err)?;
                self.pc
                    .set_remote_description(answer)
                    .await
                    .map_err(rtc_err)?;
                let early = self
                    .early
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take()
                    .unwrap_or_default();
                for c in early {
                    self.pc.add_ice_candidate(c).await.map_err(rtc_err)?;
                }
                Ok(())
            }
            In::Candidate(c) => {
                if c.candidate.is_empty() {
                    return Ok(()); // the browser's end-of-candidates form
                }
                let init = RTCIceCandidateInit {
                    candidate: c.candidate,
                    sdp_mid: c.sdp_mid,
                    sdp_mline_index: c.sdp_mline_index,
                    ..Default::default()
                };
                {
                    let mut early = self.early.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(queue) = early.as_mut() {
                        queue.push(init);
                        return Ok(());
                    }
                }
                self.pc.add_ice_candidate(init).await.map_err(rtc_err)
            }
            In::EndOfCandidates => Ok(()),
            In::Close => {
                self.close().await;
                Ok(())
            }
        }
    }

    pub async fn close(&self) {
        if self.shared.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.pc.close().await;
        self.done.send_replace(true);
    }

    /// Resolves once closed (a `close` line, a failed connection, or [`close`](Self::close)).
    pub async fn closed(&self) {
        let mut rx = self.done.subscribe();
        let _ = rx.wait_for(|done| *done).await;
    }

    fn keyframe(&self, source: &Source, reason: KeyframeReason) {
        self.outbox.send(Out::KeyframeRequest { reason });
        source.request_keyframe();
    }
}

async fn forward_channel(dc: Arc<dyn DataChannel>, outbox: Outbox) {
    let label = dc.label().await.unwrap_or_default();
    while let Some(event) = dc.poll().await {
        match event {
            DataChannelEvent::OnMessage(msg) => {
                if !msg.is_string {
                    log::warn!("publisher: binary message on {label} dropped");
                    continue;
                }
                outbox.send(Out::Input {
                    channel: label.clone(),
                    data: String::from_utf8_lossy(&msg.data).into_owned(),
                });
            }
            DataChannelEvent::OnClose => break,
            _ => {}
        }
    }
}

async fn rtcp_loop(
    track: Arc<TrackLocalStaticRTP>,
    source: Arc<Source>,
    outbox: Outbox,
    shared: Arc<Shared>,
) {
    let mut last: Option<Instant> = None;
    // The track yields nothing until it is bound (after the answer); poll() returns None until then.
    loop {
        match track.poll().await {
            Some(TrackLocalEvent::OnRtcpPacket(packets)) => {
                if !packets.iter().any(|p| is_keyframe_request(p.as_ref())) {
                    continue;
                }
                shared.plis.fetch_add(1, Ordering::Relaxed);
                if last.is_some_and(|t| t.elapsed() < PLI_COALESCE) {
                    continue;
                }
                last = Some(Instant::now());
                outbox.send(Out::KeyframeRequest {
                    reason: KeyframeReason::Pli,
                });
                source.request_keyframe();
            }
            Some(_) => {}
            None => {
                if shared.closed.load(Ordering::Relaxed) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn media_loop(
    publisher: Arc<Publisher>,
    track: Arc<TrackLocalStaticRTP>,
    ssrc: u32,
    source: Arc<Source>,
    mut state: watch::Receiver<RTCPeerConnectionState>,
    sent: Option<mpsc::UnboundedSender<Sent>>,
) {
    let shared = publisher.shared.clone();
    let mut packetizer = Packetizer::new(rand_u32() as u16);
    let mut connected = false;
    let mut waiting_for_key = true;
    loop {
        let event = tokio::select! {
            changed = state.changed() => {
                if changed.is_err() {
                    return;
                }
                let now = *state.borrow_and_update();
                match now {
                    RTCPeerConnectionState::Connected if !connected => {
                        connected = true;
                        waiting_for_key = true;
                        publisher.keyframe(&source, KeyframeReason::Connected);
                    }
                    RTCPeerConnectionState::Connected => {}
                    _ => connected = false,
                }
                continue;
            }
            event = source.queue.pop() => event,
        };
        match event {
            SourceEvent::Unit(unit) => {
                if !connected || (waiting_for_key && !unit.key()) {
                    shared.units_dropped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                waiting_for_key = false;
                if !write_unit(&track, &mut packetizer, ssrc, &unit, &shared).await {
                    shared.units_dropped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                if let Some(sent) = &sent {
                    let _ = sent.send(Sent {
                        rtp_timestamp: rtp_timestamp(unit.pts_us),
                        at: Instant::now(),
                    });
                }
            }
            SourceEvent::Dropped(n) => {
                shared.units_dropped.fetch_add(n, Ordering::Relaxed);
                if connected {
                    waiting_for_key = true;
                    publisher.keyframe(&source, KeyframeReason::Drop);
                }
            }
            SourceEvent::End(None) => {
                log::info!("publisher: source finished");
                return;
            }
            SourceEvent::End(Some(reason)) => {
                publisher.outbox.send(Out::Error {
                    code: "SOURCE".to_owned(),
                    message: reason,
                });
                publisher.close().await;
                return;
            }
        }
    }
}

async fn write_unit(
    track: &TrackLocalStaticRTP,
    packetizer: &mut Packetizer,
    ssrc: u32,
    unit: &Unit,
    shared: &Shared,
) -> bool {
    let packets = packetizer.packets(ssrc, PAYLOAD_TYPE, rtp_timestamp(unit.pts_us), &unit.data);
    for packet in packets {
        let bytes = 12 + packet.payload.len() as u64;
        if let Err(e) = track.write_rtp(packet).await {
            log::warn!("publisher: write failed: {e}");
            return false;
        }
        shared.rtp_bytes.fetch_add(bytes, Ordering::Relaxed);
    }
    shared.units_sent.fetch_add(1, Ordering::Relaxed);
    true
}

async fn stats_loop(publisher: Arc<Publisher>, every: Duration) {
    let mut tracker = Tracker::default();
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    let mut last = Instant::now();
    loop {
        tick.tick().await;
        if publisher.shared.closed.load(Ordering::Relaxed) {
            return;
        }
        let report = publisher
            .pc
            .get_stats(Instant::now(), StatsSelector::None)
            .await;
        let report = stats::read_report(&report);
        let now = Instant::now();
        let line = tracker.tick(publisher.shared.counters(), &report, now - last);
        last = now;
        publisher.outbox.send(Out::Stats(line));
    }
}

async fn watch_failure(
    publisher: Arc<Publisher>,
    mut state: watch::Receiver<RTCPeerConnectionState>,
) {
    while state.changed().await.is_ok() {
        let now = *state.borrow_and_update();
        if matches!(
            now,
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
        ) {
            publisher.close().await;
            return;
        }
    }
}
