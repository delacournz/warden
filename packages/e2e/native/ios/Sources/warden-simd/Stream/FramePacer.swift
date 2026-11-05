/// When to encode the next frame. Damage-driven: a frame only after the screen rendered one, at most `fps` a second
/// (renders in between coalesce into the next frame), plus one keepalive a `keepaliveMs` while the screen is still,
/// so a receiver that joins or loses a packet hears from the encoder. Times are monotonic nanoseconds.
struct FramePacer: Sendable {
  let interval: UInt64
  let keepalive: UInt64
  private var last: UInt64?
  private var dirty = false
  private var forced = false

  init(fps: Int, keepaliveMs: Int) {
    interval = 1_000_000_000 / UInt64(fps)
    keepalive = UInt64(keepaliveMs) * 1_000_000
  }

  /// The simulator presented a new frame.
  mutating func rendered() { dirty = true }

  /// Encode at the next chance regardless of damage (a keyframe request, a new receiver).
  mutating func force() { forced = true }

  /// The monotonic time the next frame is due, `now` when it is due already; nil until the first render.
  func deadline(now: UInt64) -> UInt64? {
    if forced { return now }
    guard let last else { return dirty ? now : nil }
    return dirty ? last + interval : last + keepalive
  }

  /// True when a frame should be encoded at `now` (and records it).
  mutating func fire(now: UInt64) -> Bool {
    guard let due = deadline(now: now), now >= due else { return false }
    last = now
    dirty = false
    forced = false
    return true
  }
}
