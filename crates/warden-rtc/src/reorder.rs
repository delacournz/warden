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

/// Lowest effective wait: below this a jittery-but-intact stream would see spurious loss.
pub const MIN_WAIT_MS: u64 = 10;
/// Effective wait is this multiple of the observed fill latency, so one slow retransmit does not
/// immediately exceed it.
const HEADROOM: f64 = 2.0;
/// Fraction of the distance to a faster sample the estimate moves; slower samples are adopted at
/// once so a deeper reorder is never under-waited twice.
const DECAY: f64 = 0.125;

/// Reorder buffer whose gap timeout follows the reordering actually seen.
///
/// The estimate starts at half of `max_wait_ms` (so the effective wait starts at the maximum),
/// then tracks how long gaps really take to fill: a fill sample is the time since the oldest
/// waiting packet arrived. Late packets that land in a gap already given up on also count, so a
/// wait that was too short corrects itself instead of staying short forever.
pub struct Reorder {
    /// Extended (wrap-free) sequence number expected next.
    next: Option<u64>,
    buffered: BTreeMap<u64, (u64, Packet)>,
    max_wait_ms: u64,
    min_wait_ms: u64,
    capacity: usize,
    observed_ms: f64,
    /// The most recent abandoned gap: extended seq range and when its wait began.
    abandoned: Option<(u64, u64, u64)>,
}

impl Reorder {
    pub fn new(max_wait_ms: u64, capacity: usize) -> Self {
        Self {
            next: None,
            buffered: BTreeMap::new(),
            max_wait_ms,
            min_wait_ms: MIN_WAIT_MS,
            capacity,
            observed_ms: max_wait_ms as f64 / 2.0,
            abandoned: None,
        }
    }

    /// Override the lower bound of the effective wait.
    #[cfg(test)]
    pub fn with_min_wait_ms(mut self, min_wait_ms: u64) -> Self {
        self.min_wait_ms = min_wait_ms;
        self
    }

    /// Current gap timeout: `2 x` observed fill latency, clamped to `[min, max_wait_ms]`.
    pub fn effective_wait_ms(&self) -> u64 {
        let wanted = (self.observed_ms * HEADROOM).ceil() as u64;
        wanted.max(self.min_wait_ms).min(self.max_wait_ms)
    }

    fn observe(&mut self, sample_ms: u64) {
        let sample = sample_ms as f64;
        if sample >= self.observed_ms {
            self.observed_ms = sample;
        } else {
            self.observed_ms += (sample - self.observed_ms) * DECAY;
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
        if ext < next {
            if let Some((start, end, since)) = self.abandoned {
                if (start..end).contains(&ext) {
                    self.observe(now_ms.saturating_sub(since));
                    self.abandoned = None;
                }
            }
            return Vec::new();
        }
        if self.buffered.contains_key(&ext) {
            return Vec::new();
        }
        if ext == next {
            if let Some(since) = self.buffered.values().map(|(arrived, _)| *arrived).min() {
                self.observe(now_ms.saturating_sub(since));
            }
        }
        self.buffered.insert(ext, (now_ms, packet));
        self.drain(now_ms)
    }

    /// Release gaps that have waited out the effective wait, without a new packet. Call on a
    /// timer (about every 10 ms).
    pub fn poll(&mut self, now_ms: u64) -> Vec<Packet> {
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
            let stale = now_ms.saturating_sub(arrived) >= self.effective_wait_ms();
            if !stale && self.buffered.len() < self.capacity {
                return out;
            }
            let since = self
                .buffered
                .values()
                .map(|(arrived, _)| *arrived)
                .min()
                .unwrap_or(arrived);
            self.abandoned = Some((next, oldest, since));
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

    fn settle_fast_fills(r: &mut Reorder, rounds: u16) -> u64 {
        let mut t = 0;
        let mut seq = 1u16;
        r.push(p(seq), t);
        for _ in 0..rounds {
            t += 100;
            r.push(p(seq.wrapping_add(2)), t);
            t += 2;
            r.push(p(seq.wrapping_add(1)), t);
            seq = seq.wrapping_add(2);
        }
        t
    }

    #[test]
    fn starts_at_the_maximum_wait() {
        assert_eq!(Reorder::new(200, 100).effective_wait_ms(), 200);
    }

    #[test]
    fn wait_shrinks_to_twice_the_observed_fill_latency() {
        let mut r = Reorder::new(200, 2048);
        settle_fast_fills(&mut r, 80);
        let wait = r.effective_wait_ms();
        assert!((10..=14).contains(&wait), "wait was {wait}");
    }

    #[test]
    fn wait_never_drops_below_the_minimum() {
        let mut r = Reorder::new(200, 2048).with_min_wait_ms(30);
        settle_fast_fills(&mut r, 200);
        assert_eq!(r.effective_wait_ms(), 30);
    }

    #[test]
    fn wait_never_exceeds_the_maximum() {
        let mut r = Reorder::new(50, 2048);
        r.push(p(1), 0);
        r.push(p(3), 1);
        r.push(p(2), 900);
        assert_eq!(r.effective_wait_ms(), 50);
    }

    #[test]
    fn a_slow_fill_raises_the_wait_at_once() {
        let mut r = Reorder::new(200, 2048);
        let t = settle_fast_fills(&mut r, 80);
        let base = r.effective_wait_ms();
        let seq = 1 + 2 * 80;
        r.push(p(seq + 2), t + 10);
        r.push(p(seq + 1), t + 70);
        assert!(r.effective_wait_ms() >= 120 && r.effective_wait_ms() > base);
    }

    #[test]
    fn a_late_arrival_after_giving_up_raises_the_wait() {
        let mut r = Reorder::new(200, 2048).with_min_wait_ms(10);
        let t = settle_fast_fills(&mut r, 80);
        let wait = r.effective_wait_ms();
        let seq = 1 + 2 * 80;
        r.push(p(seq + 2), t + 10);
        let released = r.poll(t + 10 + wait);
        assert_eq!(seqs(&released), vec![seq + 2]);
        assert!(r.push(p(seq + 1), t + 10 + wait + 40).is_empty());
        assert!(r.effective_wait_ms() >= wait + 40);
    }

    #[test]
    fn poll_releases_a_stale_gap_without_a_new_packet() {
        let mut r = Reorder::new(200, 100);
        r.push(p(1), 0);
        assert!(r.push(p(3), 10).is_empty());
        assert!(r.poll(100).is_empty(), "still within the wait");
        assert_eq!(seqs(&r.poll(210)), vec![3]);
        assert!(r.poll(400).is_empty());
    }

    #[test]
    fn poll_with_nothing_buffered_is_empty() {
        let mut r = Reorder::new(200, 100);
        assert!(r.poll(1_000).is_empty());
        r.push(p(1), 0);
        assert!(r.poll(1_000).is_empty());
    }

    #[test]
    fn a_shrunk_wait_gives_up_sooner() {
        let mut r = Reorder::new(200, 2048);
        let t = settle_fast_fills(&mut r, 80);
        let seq = 1 + 2 * 80;
        r.push(p(seq + 2), t + 10);
        assert_eq!(seqs(&r.poll(t + 10 + 30)), vec![seq + 2]);
    }
}
