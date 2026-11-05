import Foundation

enum StreamOps {
  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "stream.start": { session, params in
      try await session.streams.start(session: session, request: StreamStartRequest(params))
    },
    "stream.keyframe": { session, _ in
      try session.streams.keyframe()
    },
    "stream.stats": { session, _ in
      try session.streams.stats()
    },
    "stream.stop": { session, _ in
      .object(["stopped": .bool(session.streams.stop())])
    },
  ]
}

/// `stream.start{fps?, bitrate?, maxEdge?, keepaliveMs?, path?}`: H.264 of the main display onto a unix socket.
/// `fps` 1–60 (default 60) caps the rate, frames only follow renders; `bitrate` bits/s 100 000–20 000 000 (default
/// 4 000 000); `maxEdge` caps the long side in pixels (default 1280; 0 = device pixels); `keepaliveMs` 100–10 000
/// (default 1000) repeats a still screen; `path` is the socket (default under the helper's temp dir).
struct StreamStartRequest: Equatable, Sendable {
  struct Size: Equatable, Sendable {
    var width: Int
    var height: Int
  }

  var fps: Int
  var bitrate: Int
  var maxEdge: Int
  var keepaliveMs: Int
  var path: String?

  init(fps: Int, bitrate: Int, maxEdge: Int, keepaliveMs: Int, path: String?) {
    self.fps = fps
    self.bitrate = bitrate
    self.maxEdge = maxEdge
    self.keepaliveMs = keepaliveMs
    self.path = path
  }

  init(_ params: JSON) throws {
    func int(_ key: String, default value: Int, in range: ClosedRange<Int>, or extra: Int? = nil) throws -> Int {
      guard let raw = params[key], raw != .null else { return value }
      guard let number = raw.intValue, range.contains(number) || number == extra else {
        let zero = extra.map { " (or \($0))" } ?? ""
        throw WireError(.badRequest, "\"\(key)\" must be an integer in \(range.lowerBound)...\(range.upperBound)\(zero)")
      }
      return number
    }
    fps = try int("fps", default: 60, in: 1...60)
    bitrate = try int("bitrate", default: 4_000_000, in: 100_000...20_000_000)
    maxEdge = try int("maxEdge", default: 1280, in: 160...8192, or: 0)
    keepaliveMs = try int("keepaliveMs", default: 1000, in: 100...10_000)
    if let raw = params["path"], raw != .null {
      guard let value = raw.stringValue, !value.isEmpty else {
        throw WireError(.badRequest, "\"path\" must be a non-empty string")
      }
      path = value
    } else {
      path = nil
    }
  }

  /// The encode size for a `width`×`height` display: the long side capped at `maxEdge` (0 = no cap), aspect kept,
  /// both sides even (4:2:0).
  static func encodeSize(width: Int, height: Int, maxEdge: Int) -> Size {
    let long = max(width, height)
    let scale = maxEdge > 0 && long > maxEdge ? Double(maxEdge) / Double(long) : 1
    func even(_ value: Int) -> Int { max(2, Int((Double(value) * scale).rounded(.down)) & ~1) }
    return Size(width: even(width), height: even(height))
  }
}

/// The helper's one stream (a device has one display). A new `stream.start` replaces a running one.
final class StreamHolder: @unchecked Sendable {
  private let lock = NSLock()
  private var current: StreamSession?

  func start(session: Session, request: StreamStartRequest) async throws -> JSON {
    _ = stop()
    let defaultPath = (NSTemporaryDirectory() as NSString).appendingPathComponent(
      "wsimd-\(session.udid.prefix(8)).sock")
    let stream = try await StreamSession.start(simulator: session.simulator, request: request, defaultPath: defaultPath)
    lock.withLock { current = stream }
    let size = stream.size
    return .object([
      "path": .string(stream.socket.path), "width": .int(size.width), "height": .int(size.height),
      "fps": .int(request.fps), "bitrate": .int(request.bitrate),
      "framing": .string("u32 length, u8 flags (1 key, 2 config), u64 pts_us, Annex-B; big-endian"),
    ])
  }

  func keyframe() throws -> JSON {
    guard let stream = lock.withLock({ current }) else { throw WireError(.badRequest, "no stream is running") }
    stream.forceKeyframe()
    return .object([:])
  }

  func stats() throws -> JSON {
    guard let stream = lock.withLock({ current }) else { throw WireError(.badRequest, "no stream is running") }
    return stream.stats
  }

  /// True when a stream was running.
  func stop() -> Bool {
    guard let stream = lock.withLock({ () -> StreamSession? in
      defer { current = nil }
      return current
    }) else { return false }
    stream.stop()
    return true
  }
}
