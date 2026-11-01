//! A small RTP reorder buffer in front of the H264 assembler.
//!
//! Revyl's SFU delivers video packets out of order, and the NACK interceptor's retransmissions
//! arrive late and twice. Released strictly in sequence order, a 400-packet keyframe survives; a
//! gap is only given up on after `max_wait` (or when the buffer is full), and the assembler then
//! sees it as loss.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub seq: u16,
    pub timestamp: u32,
    pub payload: Vec<u8>,
}

pub struct Reorder {
    /// Extended (wrap-free) sequence number expected next.
    next: Option<u64>,
    buffered: BTreeMap<u64, (u64, Packet)>,
    max_wait_ms: u64,
    capacity: usize,
}

impl Reorder {
    pub fn new(max_wait_ms: u64, capacity: usize) -> Self {
        Self {
            next: None,
            buffered: BTreeMap::new(),
            max_wait_ms,
            capacity,
        }
    }

    /// The extended sequence number of `seq` nearest to `reference`.
    fn extend(reference: u64, seq: u16) -> u64 {
        let base = reference & !0xffff;
        let candidates = [
            base.wrapping_sub(0x1_0000) | u64::from(seq),
            base | u64::from(seq),
            (base + 0x1_0000) | u64::from(seq),
        ];
        candidates
            .into_iter()
            .min_by_key(|c| c.abs_diff(reference))
            .unwrap_or(base | u64::from(seq))
    }

    /// Add one packet received at `now_ms`; returns the packets now releasable, in order.
    pub fn push(&mut self, packet: Packet, now_ms: u64) -> Vec<Packet> {
        let next = *self.next.get_or_insert(0x1_0000 | u64::from(packet.seq));
        let ext = Self::extend(next, packet.seq);
        if ext < next || self.buffered.contains_key(&ext) {
            return Vec::new(); // late or duplicate
        }
        self.buffered.insert(ext, (now_ms, packet));
        self.drain(now_ms)
    }

    fn drain(&mut self, now_ms: u64) -> Vec<Packet> {
        let mut out = Vec::new();
        loop {
            let Some(mut next) = self.next else {
                return out;
            };
            while let Some((_, packet)) = self.buffered.remove(&next) {
                out.push(packet);
                next += 1;
            }
            self.next = Some(next);
            let Some((&oldest, &(arrived, _))) = self.buffered.iter().next() else {
                return out;
            };
            let stale = now_ms.saturating_sub(arrived) >= self.max_wait_ms;
            if !stale && self.buffered.len() < self.capacity {
                return out;
            }
            self.next = Some(oldest); // give up on the gap
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(seq: u16) -> Packet {
        Packet {
            seq,
            timestamp: 0,
            payload: vec![seq as u8],
        }
    }

    fn seqs(packets: &[Packet]) -> Vec<u16> {
        packets.iter().map(|p| p.seq).collect()
    }

    #[test]
    fn in_order_packets_pass_straight_through() {
        let mut r = Reorder::new(200, 100);
        assert_eq!(seqs(&r.push(p(5), 0)), vec![5]);
        assert_eq!(seqs(&r.push(p(6), 0)), vec![6]);
    }

    #[test]
    fn holds_until_the_gap_fills_then_releases_in_order() {
        let mut r = Reorder::new(200, 100);
        r.push(p(1), 0);
        assert!(r.push(p(3), 10).is_empty());
        assert!(r.push(p(4), 20).is_empty());
        assert_eq!(seqs(&r.push(p(2), 30)), vec![2, 3, 4]);
    }

    #[test]
    fn drops_late_and_duplicate_packets() {
        let mut r = Reorder::new(200, 100);
        r.push(p(1), 0);
        r.push(p(2), 0);
        assert!(r.push(p(2), 1).is_empty());
        assert!(r.push(p(1), 1).is_empty());
        r.push(p(4), 2);
        assert!(r.push(p(4), 3).is_empty(), "already buffered");
    }

    #[test]
    fn gives_up_on_a_gap_after_max_wait() {
        let mut r = Reorder::new(200, 100);
        r.push(p(1), 0);
        assert!(r.push(p(3), 10).is_empty());
        assert_eq!(seqs(&r.push(p(4), 250)), vec![3, 4]);
        assert!(r.push(p(2), 260).is_empty(), "too late now");
    }

    #[test]
    fn gives_up_when_full() {
        let mut r = Reorder::new(10_000, 3);
        r.push(p(1), 0);
        r.push(p(3), 0);
        r.push(p(4), 0);
        assert_eq!(seqs(&r.push(p(5), 0)), vec![3, 4, 5]);
    }

    #[test]
    fn handles_sequence_wrap() {
        let mut r = Reorder::new(200, 100);
        r.push(p(65534), 0);
        assert!(r.push(p(0), 0).is_empty());
        assert_eq!(seqs(&r.push(p(65535), 0)), vec![65535, 0]);
        assert_eq!(seqs(&r.push(p(1), 0)), vec![1]);
    }
}
