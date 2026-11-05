//! RFC 6184 packetizing: one RTP timestamp per access unit, SPS/PPS in a STAP-A ahead of the IDR,
//! the marker on the last packet of a unit only, sequence numbers continuous across units.

use bytes::Bytes;
use rtc::rtp::codec::h264::H264Payloader;
use rtc::rtp::packetizer::Payloader;
use rtc::rtp::{Header, Packet};

/// RTP payload budget: a 1200-byte packet less the 12-byte RTP header. Fits every path, TURN included.
pub const PAYLOAD_MTU: usize = 1200 - 12;

/// Annex-B access units into RTP packets, sequence numbers continuous across units.
pub struct Packetizer {
    payloader: H264Payloader,
    seq: u16,
}

impl Packetizer {
    pub fn new(first_seq: u16) -> Self {
        Self {
            payloader: H264Payloader::default(),
            seq: first_seq,
        }
    }

    pub fn packets(
        &mut self,
        ssrc: u32,
        payload_type: u8,
        timestamp: u32,
        annexb: &[u8],
    ) -> Vec<Packet> {
        let payloads = match self
            .payloader
            .payload(PAYLOAD_MTU, &Bytes::copy_from_slice(annexb))
        {
            Ok(p) => p,
            Err(e) => {
                log::warn!("rtp: packetize failed: {e}");
                return Vec::new();
            }
        };
        let last = payloads.len().saturating_sub(1);
        payloads
            .into_iter()
            .enumerate()
            .map(|(i, payload)| {
                let sequence_number = self.seq;
                self.seq = self.seq.wrapping_add(1);
                Packet {
                    header: Header {
                        version: 2,
                        marker: i == last,
                        payload_type,
                        sequence_number,
                        timestamp,
                        ssrc,
                        ..Default::default()
                    },
                    payload,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: [u8; 4] = [0x67, 0x42, 0xe0, 0x1f];
    const PPS: [u8; 2] = [0x68, 0xce];

    fn annexb(nals: &[&[u8]]) -> Vec<u8> {
        nals.iter()
            .flat_map(|n| [&[0, 0, 0, 1][..], n].concat())
            .collect()
    }

    #[test]
    fn one_timestamp_per_unit_and_the_marker_on_the_last_packet_only() {
        let mut p = Packetizer::new(10);
        let idr: Vec<u8> = std::iter::once(0x65)
            .chain(std::iter::repeat_n(7, 3000))
            .collect();
        let packets = p.packets(1, 102, 900, &annexb(&[&[0x09, 0xf0], &SPS, &PPS, &idr]));
        assert!(packets.len() > 2, "the IDR is fragmented");
        assert!(packets
            .iter()
            .all(|pk| pk.header.timestamp == 900 && pk.header.ssrc == 1));
        let markers: Vec<bool> = packets.iter().map(|pk| pk.header.marker).collect();
        assert_eq!(markers.iter().filter(|m| **m).count(), 1);
        assert!(markers[markers.len() - 1]);
        assert_eq!(packets[0].payload[0] & 0x1f, 24, "SPS+PPS lead as a STAP-A");
    }

    #[test]
    fn sequence_numbers_run_on_across_units_and_wrap() {
        let mut p = Packetizer::new(u16::MAX);
        let a = p.packets(1, 102, 100, &annexb(&[&[0x41, 1]]));
        let b = p.packets(1, 102, 200, &annexb(&[&[0x41, 2]]));
        assert_eq!(a[0].header.sequence_number, u16::MAX);
        assert_eq!(b[0].header.sequence_number, 0);
        assert!(a[0].header.marker && b[0].header.marker);
    }
}
