import Foundation
import WardenStream

/// The `warden-emud` wire: NDJSON, one request per line `{id, op, ...params}`, one reply per request
/// `{id, ok: true, data}` or `{id, ok: false, error: {code, message, retryable}}`, the same shapes as `warden-simd`.
/// Ops: `stream.start`, `stream.keyframe`, `stream.stats`, `stream.stop`, `health`. The gRPC token comes from
/// the environment (`WARDEN_EMU_GRPC_TOKEN`), never a request or argv.
package final class EmuServer: @unchecked Sendable {
  package static let protocolVersion = 1
  package static let framing = "u32 length, u8 flags (1 key, 2 config), u64 pts_us, Annex-B; big-endian"
  package static let tokenEnv = "WARDEN_EMU_GRPC_TOKEN"

  private let token: String?
  private let defaultPath: (EmuStartRequest) -> String
  private let frameDir: String
  private let lock = NSLock()
  private var session: EmuStreamSession?

  package init(token: String?, frameDir: String, defaultPath: @escaping (EmuStartRequest) -> String) {
    self.token = token
    self.frameDir = frameDir
    self.defaultPath = defaultPath
  }

  package static var readyLine: Data {
    line(["event": "ready", "protocol": protocolVersion, "pid": Int(getpid()), "ops": ["stream.start", "stream.keyframe", "stream.stats", "stream.stop", "health"]])
  }

  package func handle(line raw: Data) -> Data {
    guard let object = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
      return Self.failure(id: nil, StreamError(.badRequest, "request is not a JSON object"))
    }
    guard let id = object["id"] as? String, !id.isEmpty else {
      return Self.failure(id: nil, StreamError(.badRequest, "\"id\" must be a non-empty string"))
    }
    guard let op = object["op"] as? String else {
      return Self.failure(id: id, StreamError(.badRequest, "request has no \"op\" string"))
    }
    do {
      return Self.success(id: id, try run(op: op, params: object))
    } catch let error as StreamError {
      return Self.failure(id: id, error)
    } catch {
      return Self.failure(id: id, StreamError(.internal, "\(error)"))
    }
  }

  /// Ends the running stream (stdin closed, a signal).
  package func shutdown() {
    lock.withLock { () -> EmuStreamSession? in
      defer { session = nil }
      return session
    }?.stop()
  }

  private func run(op: String, params: [String: Any]) throws -> Any {
    switch op {
    case "health":
      return ["protocol": Self.protocolVersion, "token": token?.isEmpty == false, "streaming": lock.withLock { session != nil }]
    case "stream.start":
      let request = try EmuStartRequest.parse(params)
      guard let token, !token.isEmpty else {
        throw StreamError(.badRequest, "no gRPC token: set \(Self.tokenEnv)")
      }
      shutdown()
      let started = try EmuStreamSession.start(
        request: request, token: token, defaultPath: defaultPath(request), frameDir: frameDir)
      lock.withLock { session = started }
      let size = started.encodeSize
      return [
        "path": started.socket.path, "width": size.width, "height": size.height, "fps": request.fps,
        "bitrate": request.bitrate, "source": "grpc", "framing": Self.framing,
      ]
    case "stream.keyframe":
      try running().forceKeyframe()
      return [String: Any]()
    case "stream.stats":
      return try running().stats
    case "stream.stop":
      let current = lock.withLock { () -> EmuStreamSession? in
        defer { session = nil }
        return session
      }
      current?.stop()
      return ["stopped": current != nil]
    default:
      throw StreamError(.badRequest, "unknown op \(op)")
    }
  }

  private func running() throws -> EmuStreamSession {
    guard let current = lock.withLock({ session }) else { throw StreamError(.badRequest, "no stream is running") }
    return current
  }

  static func line(_ object: [String: Any]) -> Data {
    var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    data.append(0x0A)
    return data
  }

  static func success(id: String, _ data: Any) -> Data {
    line(["id": id, "ok": true, "data": data])
  }

  static func failure(id: String?, _ error: StreamError) -> Data {
    line([
      "id": id ?? NSNull(), "ok": false,
      "error": ["code": error.code.rawValue, "message": error.message, "retryable": false],
    ])
  }
}
