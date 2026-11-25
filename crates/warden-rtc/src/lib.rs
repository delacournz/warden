//! H.264 over RTP and WebRTC pieces shared by the warden viewer (`apps/viewer`) and the stream publisher.
//!
//! - [`codec`]: the H.264 codec parameters both ends negotiate.
//! - [`packetize`]: Annex-B access units into RTP packets.
//! - [`reorder`]: an RTP reorder buffer whose gap wait follows the reordering seen.
//! - [`h264`]: RTP packets back into Annex-B access units, with keyframe requests on loss.

pub mod codec;
pub mod h264;
pub mod packetize;
pub mod reorder;
