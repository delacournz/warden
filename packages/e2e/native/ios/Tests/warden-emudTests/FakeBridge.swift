import Foundation

@testable import WardenEmu

/// An in-process stand-in for the emulator's gRPC bridge: accepts one h2c connection, records what the client sent,
/// writes frames into the client's mmap file and announces them as `Image` replies.
final class FakeBridge: @unchecked Sendable {
  let port: Int
  private let listener: Int32
  private var client: Int32 = -1
  private let lock = NSLock()
  private var received = Data()
  private(set) var mmapPath: String?
  private(set) var headerBlock = Data()
  private var frames = H2.FrameReader()
  private var sawPreface = false
  private(set) var sawSettingsAck = false
  private(set) var pingAck: Data?
  private let accepted = DispatchSemaphore(value: 0)
  private let requested = DispatchSemaphore(value: 0)

  static func unusedPort() throws -> Int {
    let bridge = try FakeBridge()
    let port = bridge.port
    bridge.close()
    return port
  }

  init() throws {
    let listener = socket(AF_INET, SOCK_STREAM, 0)
    var one: Int32 = 1
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr)
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0, listen(listener, 1) == 0 else { throw NSError(domain: "FakeBridge", code: Int(errno)) }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) }
    }
    self.listener = listener
    port = Int(UInt16(bigEndian: address.sin_port))
  }

  /// Accept and read in the background.
  func serve() {
    Thread { [self] in
      let fd = accept(listener, nil, nil)
      lock.withLock { client = fd }
      accepted.signal()
      var buffer = [UInt8](repeating: 0, count: 65536)
      while true {
        let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        guard count > 0 else { return }
        consume(Data(buffer[0..<count]))
      }
    }.start()
  }

  private func consume(_ chunk: Data) {
    var data = chunk
    if !sawPreface {
      received.append(data)
      guard received.count >= H2.preface.count else { return }
      sawPreface = received.prefix(H2.preface.count) == H2.preface
      data = received.dropFirst(H2.preface.count)
    }
    for frame in frames.push(data) {
      switch H2.FrameType(rawValue: frame.type) {
      case .settings where frame.flags & H2.Flag.ack != 0: lock.withLock { sawSettingsAck = true }
      case .ping where frame.flags & H2.Flag.ack != 0: lock.withLock { pingAck = frame.payload }
      case .headers: lock.withLock { headerBlock.append(frame.payload) }
      case .data:
        var reader = GrpcMessageReader()
        for message in reader.push(frame.payload) {
          _ = Proto.fields(Array(message)) { number, _, bytes in
            guard number == 6, let bytes else { return }
            _ = Proto.fields(bytes) { inner, _, handle in
              if inner == 2, let handle {
                self.lock.withLock { self.mmapPath = String(decoding: handle, as: UTF8.self).replacingOccurrences(of: "file://", with: "") }
              }
            }
          }
        }
        requested.signal()
      default: continue
      }
    }
  }

  func waitForRequest(timeout: TimeInterval = 5) -> Bool {
    requested.wait(timeout: .now() + timeout) == .success
  }

  func send(_ data: Data) {
    let fd = lock.withLock { client }
    data.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
  }

  /// Fill the mmap file with one colour and announce the frame.
  func frame(width: Int, height: Int, seq: UInt64, rgb: (UInt8, UInt8, UInt8)) {
    if let path = lock.withLock({ mmapPath }), let handle = FileHandle(forWritingAtPath: path) {
      var pixels = Data(count: width * height * 3)
      pixels.withUnsafeMutableBytes { raw in
        for i in stride(from: 0, to: raw.count, by: 3) {
          raw[i] = rgb.0
          raw[i + 1] = rgb.1
          raw[i + 2] = rgb.2
        }
      }
      handle.write(pixels)
      try? handle.close()
    }
    let message = ImageHeader(width: width, height: height, seq: seq, timestampUs: 1).encoded
    send(H2.frame(.data, stream: 1, payload: GrpcMessageReader.frame(message)))
  }

  func close() {
    Darwin.close(listener)
    let fd = lock.withLock { client }
    if fd >= 0 { Darwin.close(fd) }
  }
}
