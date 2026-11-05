import Foundation

/// The stream's unix socket: one reader at a time (a newer connection replaces the older), framed units
/// (`AUFraming`) written from a queue of at most `maxQueued`. A reader that falls behind never makes latency grow:
/// the queue is emptied and `onNeedKeyframe` asks the encoder for a keyframe, so the reader resumes on an IDR. A new
/// reader asks for one too, so it starts on an IDR.
final class AUSocket: @unchecked Sendable {
  let path: String
  private let listener: Int32
  private let maxQueued: Int
  private let onNeedKeyframe: @Sendable () -> Void
  private let lock = NSLock()
  private let ready = NSCondition()
  private var client: Int32 = -1
  private var queue: [Data] = []
  private var closed = false
  private var dropped = 0
  private var sent = 0
  private var sentBytes = 0

  init(path: String, maxQueued: Int = 3, onNeedKeyframe: @escaping @Sendable () -> Void) throws {
    self.path = path
    self.maxQueued = maxQueued
    self.onNeedKeyframe = onNeedKeyframe
    unlink(path)
    listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else { throw WireError(.io, "socket: errno \(errno)") }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
      Darwin.close(listener)
      throw WireError(.badRequest, "stream socket path is longer than \(MemoryLayout.size(ofValue: addr.sun_path) - 1) bytes")
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in raw.copyBytes(from: bytes) }
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0, listen(listener, 2) == 0 else {
      let code = errno
      Darwin.close(listener)
      throw WireError(.io, "could not listen on \(path): errno \(code)")
    }
    chmod(path, 0o600)
    Thread.detachNewThread { [weak self] in self?.acceptLoop() }
    Thread.detachNewThread { [weak self] in self?.writeLoop() }
  }

  var stats: (sent: Int, bytes: Int, dropped: Int, connected: Bool) {
    lock.withLock { (sent, sentBytes, dropped, client >= 0) }
  }

  /// Resolves once a reader is connected.
  func waitForClient(timeoutMs: Int) async throws {
    let deadline = ContinuousClock.now + .milliseconds(timeoutMs)
    while ContinuousClock.now < deadline {
      if lock.withLock({ client >= 0 }) { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw WireError(.timeout, "no reader connected to \(path) within \(timeoutMs) ms")
  }

  func send(_ unit: EncodedUnit) {
    let framed = AUFraming.frame(unit)
    var overflow = false
    ready.lock()
    lock.withLock {
      guard client >= 0, !closed else { return }
      if queue.count >= maxQueued {
        dropped += queue.count + 1
        queue.removeAll()
        overflow = !unit.flags.contains(.key)
        if !overflow { queue.append(framed) }
      } else {
        queue.append(framed)
      }
    }
    ready.signal()
    ready.unlock()
    if overflow { onNeedKeyframe() }
  }

  func close() {
    ready.lock()
    lock.withLock {
      closed = true
      if client >= 0 { Darwin.close(client) }
      client = -1
    }
    ready.broadcast()
    ready.unlock()
    shutdown(listener, SHUT_RDWR)
    Darwin.close(listener)
    unlink(path)
  }

  private func acceptLoop() {
    while true {
      let fd = accept(listener, nil, nil)
      if fd < 0 {
        if lock.withLock({ closed }) || errno != EINTR { return }
        continue
      }
      var on: Int32 = 1
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      let previous = lock.withLock {
        let old = client
        client = fd
        queue.removeAll()
        return old
      }
      if previous >= 0 { Darwin.close(previous) }
      // A new reader starts on an IDR.
      onNeedKeyframe()
    }
  }

  private func writeLoop() {
    while true {
      ready.lock()
      var next: (fd: Int32, data: Data)?
      while next == nil {
        if lock.withLock({ closed }) {
          ready.unlock()
          return
        }
        next = lock.withLock {
          guard client >= 0, !queue.isEmpty else { return nil }
          return (client, queue.removeFirst())
        }
        if next == nil { ready.wait() }
      }
      ready.unlock()
      guard let (fd, data) = next else { continue }
      if writeAll(fd, data) {
        lock.withLock {
          sent += 1
          sentBytes += data.count
        }
      } else {
        lock.withLock {
          if client == fd {
            Darwin.close(fd)
            client = -1
            queue.removeAll()
          }
        }
      }
    }
  }

  private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
        if n < 0 {
          if errno == EINTR { continue }
          return false
        }
        offset += n
      }
      return true
    }
  }
}
