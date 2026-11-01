//! H264 over RTP (RFC 6184) into Annex-B access units, for the native stream path.
//!
//! Frames are grouped by RTP timestamp, not by the marker bit: Revyl's sender marks a lone SPS/PPS
//! packet as a finished frame and then sends the IDR with the same timestamp, which WebKit's
//! receiver never assembles. One timestamp is one access unit here, so the parameter sets land in
//! front of their IDR. A sequence gap drops everything until the next keyframe and asks for one.

const START_CODE: [u8; 4] = [0, 0, 0, 1];
const NAL_IDR: u8 = 5;
const STAP_A: u8 = 24;
const FU_A: u8 = 28;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessUnit {
    pub timestamp: u32,
    pub key: bool,
    /// Annex-B: every NAL unit prefixed with a 4-byte start code.
    pub data: Vec<u8>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pushed {
    pub units: Vec<AccessUnit>,
    /// The caller should send a PLI: a gap was seen, or no keyframe has arrived yet.
    pub request_keyframe: bool,
}

#[derive(Default)]
pub struct Assembler {
    current: Option<Pending>,
    last_seq: Option<u16>,
    /// Drop access units until a keyframe: at start, and after loss.
    waiting_for_key: bool,
    started: bool,
    dropped: u64,
}

struct Pending {
    timestamp: u32,
    data: Vec<u8>,
    key: bool,
    broken: bool,
    /// Inside a fragmented NAL (FU-A) whose start we saw.
    in_fragment: bool,
}

impl Pending {
    fn new(timestamp: u32) -> Self {
        Self {
            timestamp,
            data: Vec::new(),
            key: false,
            broken: false,
            in_fragment: false,
        }
    }

    fn nal(&mut self, nal: &[u8]) {
        if nal.is_empty() {
            return;
        }
        if nal[0] & 0x1f == NAL_IDR {
            self.key = true;
        }
        self.data.extend_from_slice(&START_CODE);
        self.data.extend_from_slice(nal);
    }

    fn payload(&mut self, payload: &[u8]) {
        let Some(&header) = payload.first() else {
            return;
        };
        match header & 0x1f {
            1..=23 => self.nal(payload),
            STAP_A => self.stap_a(&payload[1..]),
            FU_A => self.fu_a(header, &payload[1..]),
            _ => {}
        }
    }

    fn stap_a(&mut self, mut rest: &[u8]) {
        while rest.len() >= 2 {
            let size = usize::from(u16::from_be_bytes([rest[0], rest[1]]));
            rest = &rest[2..];
            if size > rest.len() {
                self.broken = true;
                return;
            }
            self.nal(&rest[..size]);
            rest = &rest[size..];
        }
    }

    fn fu_a(&mut self, indicator: u8, rest: &[u8]) {
        let Some((&fu_header, body)) = rest.split_first() else {
            return;
        };
        let start = fu_header & 0x80 != 0;
        if start {
            let nal_header = (indicator & 0xe0) | (fu_header & 0x1f);
            self.data.extend_from_slice(&START_CODE);
            self.data.push(nal_header);
            if fu_header & 0x1f == NAL_IDR {
                self.key = true;
            }
            self.in_fragment = true;
        } else if !self.in_fragment {
            self.broken = true;
            return;
        }
        self.data.extend_from_slice(body);
        if fu_header & 0x40 != 0 {
            self.in_fragment = false;
        }
    }
}

impl Assembler {
    pub fn new() -> Self {
        Self {
            waiting_for_key: true,
            ..Self::default()
        }
    }

    /// Access units discarded because a packet was lost or a fragment was left open.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Feed one RTP packet's sequence number, timestamp and payload.
    pub fn push(&mut self, seq: u16, timestamp: u32, payload: &[u8]) -> Pushed {
        let mut out = Pushed::default();
        let gap = self
            .last_seq
            .is_some_and(|last| seq != last.wrapping_add(1));
        if let Some(last) = self.last_seq {
            if seq.wrapping_sub(last) > 0x8000 || seq == last {
                return out; // late or duplicate: ignore
            }
        }
        self.last_seq = Some(seq);

        if self
            .current
            .as_ref()
            .is_some_and(|p| p.timestamp != timestamp)
        {
            self.flush(&mut out);
        }
        let pending = self.current.get_or_insert_with(|| Pending::new(timestamp));
        if gap {
            pending.broken = true;
        }
        pending.payload(payload);
        if !self.started {
            self.started = true;
            out.request_keyframe = true;
        }
        out
    }

    fn flush(&mut self, out: &mut Pushed) {
        let Some(done) = self.current.take() else {
            return;
        };
        if done.broken || done.in_fragment {
            self.dropped += 1;
            self.waiting_for_key = true;
            out.request_keyframe = true;
            return;
        }
        if self.waiting_for_key && !done.key {
            out.request_keyframe = true;
            return;
        }
        self.waiting_for_key = false;
        out.units.push(AccessUnit {
            timestamp: done.timestamp,
            key: done.key,
            data: done.data,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: [u8; 4] = [0x67, 0x42, 0xe0, 0x1f];
    const PPS: [u8; 2] = [0x68, 0xce];

    fn stap(nals: &[&[u8]]) -> Vec<u8> {
        let mut out = vec![0x78];
        for nal in nals {
            out.extend_from_slice(&(nal.len() as u16).to_be_bytes());
            out.extend_from_slice(nal);
        }
        out
    }

    fn fu(nal_type: u8, start: bool, end: bool, body: &[u8]) -> Vec<u8> {
        let mut header = nal_type;
        if start {
            header |= 0x80;
        }
        if end {
            header |= 0x40;
        }
        let mut out = vec![0x7c, header];
        out.extend_from_slice(body);
        out
    }

    fn annexb(nals: &[&[u8]]) -> Vec<u8> {
        nals.iter()
            .flat_map(|n| [&START_CODE[..], n].concat())
            .collect()
    }

    #[test]
    fn merges_a_lone_parameter_set_frame_into_the_idr_with_the_same_timestamp() {
        let mut a = Assembler::new();
        let first = a.push(1, 900, &stap(&[&SPS, &PPS]));
        assert!(first.request_keyframe);
        assert!(a
            .push(2, 900, &fu(5, true, false, &[1, 2]))
            .units
            .is_empty());
        assert!(a.push(3, 900, &fu(5, false, true, &[3])).units.is_empty());
        let next = a.push(4, 1800, &[0x41, 9]);
        assert_eq!(
            next.units,
            vec![AccessUnit {
                timestamp: 900,
                key: true,
                data: annexb(&[&SPS, &PPS, &[0x65, 1, 2, 3]]),
            }]
        );
    }

    #[test]
    fn drops_delta_frames_until_the_first_keyframe() {
        let mut a = Assembler::new();
        a.push(1, 100, &[0x41, 1]);
        let out = a.push(2, 200, &[0x41, 2]);
        assert!(out.units.is_empty());
        assert!(out.request_keyframe);
    }

    #[test]
    fn a_sequence_gap_drops_until_the_next_keyframe() {
        let mut a = Assembler::new();
        a.push(1, 100, &[0x65, 1]);
        assert_eq!(a.push(2, 200, &[0x41, 2]).units.len(), 1);
        let gap = a.push(4, 300, &[0x41, 3]);
        assert_eq!(gap.units.len(), 1); // the frame at 200 was whole
        let after = a.push(5, 400, &[0x41, 4]);
        assert!(after.units.is_empty(), "the frame at 300 lost a packet");
        assert!(after.request_keyframe);
        assert!(a.push(6, 500, &[0x65, 5]).units.is_empty()); // 400 dropped, waiting for key
        let key = a.push(7, 600, &[0x41, 6]);
        assert_eq!(key.units.len(), 1);
        assert!(key.units[0].key);
    }

    #[test]
    fn a_fragment_without_its_start_breaks_the_frame() {
        let mut a = Assembler::new();
        a.push(1, 100, &[0x65, 1]);
        assert_eq!(a.push(2, 200, &fu(1, false, true, &[7])).units.len(), 1);
        let out = a.push(3, 300, &[0x41, 1]);
        assert!(out.units.is_empty(), "the frame at 200 is broken");
        assert!(out.request_keyframe);
    }

    #[test]
    fn ignores_late_and_duplicate_packets() {
        let mut a = Assembler::new();
        a.push(10, 100, &[0x65, 1]);
        assert_eq!(a.push(10, 100, &[0x65, 1]), Pushed::default());
        assert_eq!(a.push(9, 100, &[0x65, 1]), Pushed::default());
        let out = a.push(11, 200, &[0x41, 1]);
        assert_eq!(out.units[0].data, annexb(&[&[0x65, 1]]));
    }

    #[test]
    fn sequence_numbers_wrap() {
        let mut a = Assembler::new();
        a.push(u16::MAX, 100, &[0x65, 1]);
        let out = a.push(0, 200, &[0x41, 1]);
        assert_eq!(out.units.len(), 1);
    }

    #[test]
    fn counts_access_units_dropped_to_loss() {
        let mut a = Assembler::new();
        assert_eq!(a.dropped(), 0);
        a.push(1, 100, &[0x65, 1]);
        a.push(2, 200, &[0x41, 2]);
        a.push(4, 300, &[0x41, 3]);
        a.push(5, 400, &[0x41, 4]);
        assert_eq!(a.dropped(), 1);
    }
}
