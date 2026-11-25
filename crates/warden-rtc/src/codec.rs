//! The H.264 codec both ends negotiate: packetization mode 1, Constrained Baseline 3.1 offered, any level accepted.

use rtc::peer_connection::configuration::media_engine::MIME_TYPE_H264;
use rtc::rtp_transceiver::rtp_sender::{RTCPFeedback, RTCRtpCodec};

pub const H264_FMTP: &str =
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
pub const H264_CLOCK_RATE: u32 = 90_000;

/// Receiver feedback: NACK retransmits and PLI keyframe requests.
pub fn receiver_feedback() -> Vec<RTCPFeedback> {
    [("nack", ""), ("nack", "pli")]
        .into_iter()
        .map(|(typ, parameter)| RTCPFeedback {
            typ: typ.to_owned(),
            parameter: parameter.to_owned(),
        })
        .collect()
}

pub fn h264(rtcp_feedback: Vec<RTCPFeedback>) -> RTCRtpCodec {
    RTCRtpCodec {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: H264_CLOCK_RATE,
        channels: 0,
        sdp_fmtp_line: H264_FMTP.to_owned(),
        rtcp_feedback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h264_with_and_without_feedback() {
        let plain = h264(vec![]);
        assert_eq!(plain.mime_type, MIME_TYPE_H264);
        assert_eq!(plain.clock_rate, 90_000);
        assert!(plain.sdp_fmtp_line.contains("packetization-mode=1"));
        assert!(plain.rtcp_feedback.is_empty());
        let fb: Vec<(String, String)> = receiver_feedback()
            .into_iter()
            .map(|f| (f.typ, f.parameter))
            .collect();
        assert_eq!(
            fb,
            vec![("nack".into(), "".into()), ("nack".into(), "pli".into())]
        );
    }
}
