//! `warden-stream`: a device's live H.264 published over WebRTC, signalled as NDJSON on stdio.
//!
//! - [`signal`]: the stdio protocol (`Out` on stdout, `In` on stdin).
//! - [`framing`]: the helper socket's access-unit framing, Annex-B splitting, the RTP clock.
//! - [`ice`]: `--ice auto|lan|turn`, host candidate addresses, ICE servers.
//! - [`source`]: the AU socket or a file replay, with backlog cutting.
//! - [`publisher`]: the peer connection: trickle ICE, media held until connected, PLI/NACK, data channels.
//! - [`stats`]: the once-a-second `stats` line.
//! - [`testpeer`]: a receiving peer for tests and the live bench (not used by the binary).

pub mod args;
pub mod framing;
pub mod ice;
pub mod publisher;
pub mod signal;
pub mod source;
pub mod stats;
pub mod testpeer;
