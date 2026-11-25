//! Access units in: the helper socket's framing, plain Annex-B files, and the RTP clock.
//!
//! Socket framing, per unit, big-endian: `[u32 length][u8 flags][u64 pts_us][length bytes of
//! Annex-B]`, flags `1` key (IDR) and `2` config (carries SPS/PPS). The reader is incremental: a
//! unit may arrive split across any number of reads, and one read may hold several units.

pub const HEADER_LEN: usize = 13;
pub const FLAG_KEY: u8 = 1;
pub const FLAG_CONFIG: u8 = 2;
/// Larger than any real access unit (a 4K IDR at a high bitrate is a few MB); a bigger length
/// means the stream is not this framing.
pub const MAX_UNIT_LEN: usize = 32 * 1024 * 1024;

const START_CODE: [u8; 4] = [0, 0, 0, 1];
const NAL_IDR: u8 = 5;
const NAL_SEI: u8 = 6;
const NAL_SPS: u8 = 7;
const NAL_PPS: u8 = 8;
const NAL_AUD: u8 = 9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unit {
    pub flags: u8,
    pub pts_us: u64,
    /// Annex-B.
    pub data: Vec<u8>,
}

impl Unit {
    pub fn key(&self) -> bool {
        self.flags & FLAG_KEY != 0
    }
}

/// The RTP timestamp (90 kHz) of a capture time in microseconds; wraps like RTP does.
pub fn rtp_timestamp(pts_us: u64) -> u32 {
    (u128::from(pts_us) * 90 / 1000) as u32
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FramingError(pub String);

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Incremental parser for the socket framing.
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed bytes as they were read; returns every unit now complete, in order.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Unit>, FramingError> {
        self.buf.extend_from_slice(bytes);
        let mut units = Vec::new();
        let mut at = 0;
        while self.buf.len() - at >= HEADER_LEN {
            let h = &self.buf[at..at + HEADER_LEN];
            let len = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as usize;
            if len > MAX_UNIT_LEN {
                return Err(FramingError(format!(
                    "unit of {len} bytes exceeds {MAX_UNIT_LEN}: not the stream framing"
                )));
            }
            if self.buf.len() - at < HEADER_LEN + len {
                break;
            }
            let flags = h[4];
            let mut pts = [0u8; 8];
            pts.copy_from_slice(&h[5..13]);
            let start = at + HEADER_LEN;
            units.push(Unit {
                flags,
                pts_us: u64::from_be_bytes(pts),
                data: self.buf[start..start + len].to_vec(),
            });
            at = start + len;
        }
        self.buf.drain(..at);
        Ok(units)
    }

    /// Bytes held for a unit that has not fully arrived.
    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

/// One unit in the socket framing (what the helper writes); used by tests and the file replay.
pub fn frame(unit: &Unit) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + unit.data.len());
    out.extend_from_slice(&(unit.data.len() as u32).to_be_bytes());
    out.push(unit.flags);
    out.extend_from_slice(&unit.pts_us.to_be_bytes());
    out.extend_from_slice(&unit.data);
    out
}

/// Whether a file starts like Annex-B (a start code) rather than the socket framing.
pub fn looks_like_annexb(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0, 0, 0, 1]) || bytes.starts_with(&[0, 0, 1])
}

/// The NAL units of an Annex-B buffer (3- or 4-byte start codes), without start codes or the
/// zero bytes that trail a NAL in front of the next 4-byte start code.
pub fn nal_units(annexb: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 2 < annexb.len() {
        if annexb[i] == 0 && annexb[i + 1] == 0 && annexb[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let mut end = starts.get(n + 1).map_or(annexb.len(), |next| next - 3);
            while end > start && annexb[end - 1] == 0 {
                end -= 1;
            }
            &annexb[start..end]
        })
        .filter(|nal| !nal.is_empty())
        .collect()
}

fn is_vcl(nal_type: u8) -> bool {
    (1..=5).contains(&nal_type)
}

/// A NAL that may only start an access unit (H.264 7.4.1.2.3): AUD, SPS, PPS, SEI, 14–18.
fn starts_unit(nal_type: u8) -> bool {
    matches!(nal_type, NAL_AUD | NAL_SPS | NAL_PPS | NAL_SEI | 14..=18)
}

/// A slice whose `first_mb_in_slice` is 0 (its ue(v) is the single bit `1`): a new picture.
fn first_slice_of_picture(nal: &[u8]) -> bool {
    nal.get(1).is_some_and(|b| b & 0x80 != 0)
}

/// Split an Annex-B elementary stream into access units, every NAL behind a 4-byte start code
/// (the helper's form), each flagged key / config like the socket framing.
pub fn split_access_units(annexb: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let mut units: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut current = Vec::new();
    let mut flags = 0u8;
    let mut seen_vcl = false;
    for nal in nal_units(annexb) {
        let nal_type = nal[0] & 0x1f;
        let boundary = seen_vcl
            && (starts_unit(nal_type) || (is_vcl(nal_type) && first_slice_of_picture(nal)));
        if boundary {
            units.push((flags, std::mem::take(&mut current)));
            flags = 0;
            seen_vcl = false;
        }
        match nal_type {
            NAL_IDR => flags |= FLAG_KEY,
            NAL_SPS | NAL_PPS => flags |= FLAG_CONFIG,
            _ => {}
        }
        seen_vcl |= is_vcl(nal_type);
        current.extend_from_slice(&START_CODE);
        current.extend_from_slice(nal);
    }
    if !current.is_empty() {
        units.push((flags, current));
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(flags: u8, pts_us: u64, data: &[u8]) -> Unit {
        Unit {
            flags,
            pts_us,
            data: data.to_vec(),
        }
    }

    #[test]
    fn header_layout_is_big_endian() {
        let bytes = frame(&unit(3, 0x0102_0304_0506_0708, &[0xaa, 0xbb]));
        assert_eq!(
            bytes,
            vec![0, 0, 0, 2, 3, 1, 2, 3, 4, 5, 6, 7, 8, 0xaa, 0xbb]
        );
    }

    #[test]
    fn parses_several_units_in_one_read() {
        let a = unit(FLAG_KEY | FLAG_CONFIG, 0, &[0, 0, 0, 1, 0x65, 1]);
        let b = unit(0, 16_666, &[0, 0, 0, 1, 0x41, 2]);
        let mut bytes = frame(&a);
        bytes.extend(frame(&b));
        let mut r = FrameReader::new();
        assert_eq!(r.push(&bytes).unwrap(), vec![a.clone(), b]);
        assert!(a.key());
        assert_eq!(r.pending(), 0);
    }

    #[test]
    fn a_unit_split_across_reads_completes_on_the_last_byte() {
        let a = unit(FLAG_KEY, 42, &[7; 300]);
        let bytes = frame(&a);
        for split in [
            1,
            5,
            HEADER_LEN - 1,
            HEADER_LEN,
            HEADER_LEN + 1,
            bytes.len() - 1,
        ] {
            let mut r = FrameReader::new();
            assert!(r.push(&bytes[..split]).unwrap().is_empty(), "split {split}");
            assert_eq!(r.pending(), split);
            assert_eq!(r.push(&bytes[split..]).unwrap(), vec![a.clone()]);
            assert_eq!(r.pending(), 0);
        }
    }

    #[test]
    fn byte_at_a_time_reads_yield_every_unit() {
        let units: Vec<Unit> = (0..5)
            .map(|i| unit(u8::from(i == 0), i * 1000, &vec![i as u8; 17 + i as usize]))
            .collect();
        let bytes: Vec<u8> = units.iter().flat_map(frame).collect();
        let mut r = FrameReader::new();
        let mut got = Vec::new();
        for b in bytes {
            got.extend(r.push(&[b]).unwrap());
        }
        assert_eq!(got, units);
    }

    #[test]
    fn a_unit_spanning_three_reads_with_the_next_header_attached() {
        let a = unit(0, 1, &[1; 40]);
        let b = unit(FLAG_KEY, 2, &[2; 3]);
        let mut bytes = frame(&a);
        bytes.extend(frame(&b));
        let mut r = FrameReader::new();
        assert!(r.push(&bytes[..10]).unwrap().is_empty());
        assert!(r.push(&bytes[10..30]).unwrap().is_empty());
        assert_eq!(r.push(&bytes[30..60]).unwrap(), vec![a]);
        assert_eq!(r.push(&bytes[60..]).unwrap(), vec![b]);
    }

    #[test]
    fn an_empty_unit_is_legal() {
        let mut r = FrameReader::new();
        assert_eq!(
            r.push(&frame(&unit(0, 9, &[]))).unwrap(),
            vec![unit(0, 9, &[])]
        );
    }

    #[test]
    fn rejects_an_absurd_length() {
        let mut r = FrameReader::new();
        let mut bytes = vec![0xff, 0xff, 0xff, 0xff];
        bytes.extend([0; 9]);
        assert!(r.push(&bytes).is_err());
    }

    #[test]
    fn rtp_clock_is_90khz_from_microseconds() {
        assert_eq!(rtp_timestamp(0), 0);
        assert_eq!(rtp_timestamp(1_000_000), 90_000);
        assert_eq!(rtp_timestamp(16_667), 1_500);
        assert_eq!(rtp_timestamp(11), 0);
        // Wraps at 2^32 ticks (~13.25 h) like an RTP timestamp.
        let wrap_us = (1u64 << 32) * 1000 / 90;
        assert!(rtp_timestamp(wrap_us + 1_000_000) < 100_000);
        assert_eq!(
            rtp_timestamp(u64::MAX),
            (u128::from(u64::MAX) * 90 / 1000) as u32
        );
    }

    #[test]
    fn detects_annexb_versus_framed_files() {
        assert!(looks_like_annexb(&[0, 0, 0, 1, 0x67]));
        assert!(looks_like_annexb(&[0, 0, 1, 0x67]));
        assert!(!looks_like_annexb(&frame(&unit(1, 0, &[0, 0, 0, 1, 0x65]))));
    }

    #[test]
    fn nal_units_handle_both_start_codes_and_trailing_zeros() {
        let bytes = [
            0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2, 0, 0, 0, 0, 1, 0x65, 3,
        ];
        let nals = nal_units(&bytes);
        assert_eq!(nals, vec![&[0x67, 1][..], &[0x68, 2][..], &[0x65, 3][..]]);
    }

    #[test]
    fn splits_pictures_on_first_mb_and_parameter_sets() {
        // SPS PPS IDR(first mb) | P(first mb) | SEI P(first mb) P(second slice, first_mb != 0)
        let stream = [
            &[0, 0, 0, 1, 0x67, 0x42][..],
            &[0, 0, 1, 0x68, 0xce],
            &[0, 0, 1, 0x65, 0x88, 1],
            &[0, 0, 0, 1, 0x41, 0x9a, 2],
            &[0, 0, 1, 0x06, 0x05, 9],
            &[0, 0, 1, 0x41, 0x9a, 3],
            &[0, 0, 1, 0x41, 0x40, 4],
        ]
        .concat();
        let units = split_access_units(&stream);
        let sc = |nal: &[u8]| [&START_CODE[..], nal].concat();
        assert_eq!(units.len(), 3);
        assert_eq!(units[0].0, FLAG_KEY | FLAG_CONFIG);
        assert_eq!(
            units[0].1,
            [sc(&[0x67, 0x42]), sc(&[0x68, 0xce]), sc(&[0x65, 0x88, 1])].concat()
        );
        assert_eq!(units[1], (0, sc(&[0x41, 0x9a, 2])));
        assert_eq!(
            units[2],
            (
                0,
                [
                    sc(&[0x06, 0x05, 9]),
                    sc(&[0x41, 0x9a, 3]),
                    sc(&[0x41, 0x40, 4])
                ]
                .concat()
            )
        );
    }

    #[test]
    fn the_committed_fixture_is_120_pictures_led_by_a_keyframe() {
        let bytes = include_bytes!("../tests/fixtures/fixture.h264");
        let units = split_access_units(bytes);
        assert_eq!(units.len(), 120);
        assert_eq!(units[0].0, FLAG_KEY | FLAG_CONFIG);
        assert!(units[1..].iter().all(|(flags, _)| flags & FLAG_KEY == 0));
    }
}
