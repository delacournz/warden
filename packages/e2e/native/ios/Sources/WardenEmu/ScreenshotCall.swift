import Foundation
import WardenStream

/// Where the emulator's gRPC bridge listens and the token it wants (`-grpc-use-token`).
package struct GrpcEndpoint: Equatable, Sendable {
  package var host: String
  package var port: Int
  package var token: String

  package init(host: String, port: Int, token: String) {
    self.host = host
    self.port = port
    self.token = token
  }
}

/// One `EmulatorController/streamScreenshot` call over h2c on a blocking socket. A reader thread answers SETTINGS
/// and PING, keeps the flow-control windows open, and hands each `Image` header to `onImage`; `onEnd` runs once,
/// whatever ended it (the server, the socket, `cancel()`).
package final class ScreenshotCall: @unchecked Sendable {
  package static let path = "/android.emulation.control.EmulatorController/streamScreenshot"
  private static let streamId: UInt32 = 1
  /// Window bytes handed back once this many were consumed.
  private static let windowRefill = 1 << 20

  private let fd: Int32
  private let writeLock = NSLock()
  private let stateLock = NSLock()
  private var ended = false
  private let onImage: @Sendable (ImageHeader) -> Void
  private let onEnd: @Sendable (String) -> Void

  package init(
    endpoint: GrpcEndpoint, request: ScreenshotRequest, onImage: @escaping @Sendable (ImageHeader) -> Void,
    onEnd: @escaping @Sendable (String) -> Void
  ) throws {
    self.onImage = onImage
    self.onEnd = onEnd
    fd = try Self.connect(host: endpoint.host, port: endpoint.port)
    var opening = H2.preface
    opening.append(H2.settings([(.enablePush, 0), (.initialWindowSize, H2.maxWindow)]))
    opening.append(H2.windowUpdate(stream: 0, increment: H2.maxWindow - H2.defaultWindow))
    let headers = H2.headerBlock([
      (":method", "POST"), (":scheme", "http"), (":path", Self.path), (":authority", "\(endpoint.host):\(endpoint.port)"),
      ("content-type", "application/grpc"), ("te", "trailers"), ("authorization", "Bearer \(endpoint.token)"),
    ])
    opening.append(H2.frame(.headers, flags: H2.Flag.endHeaders, stream: Self.streamId, payload: headers))
    opening.append(
      H2.frame(.data, flags: H2.Flag.endStream, stream: Self.streamId, payload: GrpcMessageReader.frame(request.encoded)))
    guard write(opening) else {
      Darwin.close(fd)
      throw StreamError(.io, "could not send the screenshot request to \(endpoint.host):\(endpoint.port)")
    }
    let thread = Thread { [self] in readLoop() }
    thread.name = "warden-emud.grpc"
    thread.qualityOfService = .userInteractive
    thread.start()
  }

  /// Ends the call; `onEnd` runs with `reason`.
  package func cancel(_ reason: String = "cancelled") {
    finish(reason)
  }

  private func finish(_ reason: String) {
    let first = stateLock.withLock { () -> Bool in
      defer { ended = true }
      return !ended
    }
    guard first else { return }
    shutdown(fd, SHUT_RDWR)
    onEnd(reason)
  }

  private func readLoop() {
    var frames = H2.FrameReader()
    var messages = GrpcMessageReader()
    var consumed = 0
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    defer { Darwin.close(fd) }
    while true {
      let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      guard count > 0 else {
        finish(count == 0 ? "the emulator closed the connection" : "read failed: errno \(errno)")
        return
      }
      for frame in frames.push(Data(buffer[0..<count])) {
        switch H2.FrameType(rawValue: frame.type) {
        case .settings where frame.flags & H2.Flag.ack == 0:
          _ = write(H2.frame(.settings, flags: H2.Flag.ack))
        case .ping where frame.flags & H2.Flag.ack == 0:
          _ = write(H2.frame(.ping, flags: H2.Flag.ack, payload: frame.payload))
        case .data where frame.stream == Self.streamId:
          guard let payload = frame.dataPayload else {
            finish("malformed DATA padding")
            return
          }
          consumed += frame.payload.count
          if consumed >= Self.windowRefill {
            var update = H2.windowUpdate(stream: 0, increment: UInt32(consumed))
            update.append(H2.windowUpdate(stream: Self.streamId, increment: UInt32(consumed)))
            _ = write(update)
            consumed = 0
          }
          for message in messages.push(payload) {
            guard !messages.compressed, let header = ImageHeader.decode(message) else {
              finish("unreadable Image message")
              return
            }
            onImage(header)
          }
          if frame.flags & H2.Flag.endStream != 0 {
            finish("the emulator ended the screenshot stream")
            return
          }
        case .headers where frame.stream == Self.streamId && frame.flags & H2.Flag.endStream != 0:
          finish("the emulator ended the screenshot stream (trailers; a wrong token is answered this way)")
          return
        case .rstStream where frame.stream == Self.streamId:
          finish("the emulator reset the screenshot stream")
          return
        case .goaway:
          finish("the emulator sent GOAWAY")
          return
        default:
          continue
        }
      }
    }
  }

  private func write(_ data: Data) -> Bool {
    writeLock.withLock {
      data.withUnsafeBytes { raw -> Bool in
        var offset = 0
        while offset < raw.count {
          let sent = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
          if sent < 0 && errno == EINTR { continue }
          guard sent > 0 else { return false }
          offset += sent
        }
        return true
      }
    }
  }

  private static func connect(host: String, port: Int) throws -> Int32 {
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(port).bigEndian)
    guard inet_pton(AF_INET, host, &address.sin_addr) == 1 else {
      throw StreamError(.badRequest, "gRPC host must be an IPv4 address, got \(host)")
    }
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw StreamError(.io, "socket: errno \(errno)") }
    var one: Int32 = 1
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard result == 0 else {
      let code = errno
      Darwin.close(fd)
      throw StreamError(.io, "connect \(host):\(port): errno \(code)")
    }
    return fd
  }
}
