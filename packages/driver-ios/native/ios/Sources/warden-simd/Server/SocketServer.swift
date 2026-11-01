import Darwin
import Foundation

// Socket mode: `warden-simd --socket <path> [--idle-timeout <s>]`. One process serves many sequential or concurrent
// clients over a unix socket (0600). Every connection gets its own `ready` event and its own NDJSON stream; the
// Session (and so HID, which is serialised on it) is shared. The process ends on `shutdown` from any client, after
// `--idle-timeout` seconds with no client and no op in flight, or on SIGTERM.

enum UnixSocket {
  struct Failure: Error, Equatable {
    let message: String
  }

  /// `sockaddr_un.sun_path` is 104 bytes on Darwin, NUL included.
  static let maxPathBytes = 103

  static func address(for path: String) throws -> sockaddr_un {
    guard path.utf8.count <= maxPathBytes else {
      throw Failure(message: "socket path is \(path.utf8.count) bytes, over the \(maxPathBytes)-byte limit: \(path)")
    }
    var address = sockaddr_un()
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      _ = path.withCString { source in strlcpy(raw.baseAddress!.assumingMemoryBound(to: CChar.self), source, raw.count) }
    }
    return address
  }

  /// A connected client descriptor, or nil when nobody is listening at `path`.
  static func connect(path: String) -> Int32? {
    guard var address = try? address(for: path) else { return nil }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if result != 0 {
      close(fd)
      return nil
    }
    return fd
  }

  /// Binds and listens at `path` with mode 0600. A stale socket file (nobody answers a connect probe) is unlinked
  /// first; a live one is an error.
  static func listen(path: String, backlog: Int32 = 16) throws -> Int32 {
    var address = try address(for: path)
    let parent = (path as NSString).deletingLastPathComponent
    if !parent.isEmpty {
      try? FileManager.default.createDirectory(
        atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    if FileManager.default.fileExists(atPath: path) {
      if let probe = connect(path: path) {
        close(probe)
        throw Failure(message: "another warden-simd is already listening on \(path)")
      }
      unlink(path)
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Failure(message: "socket(): \(String(cString: strerror(errno)))") }
    let previousMask = umask(0o177)
    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    let bindError = errno
    umask(previousMask)
    guard bound == 0 else {
      close(fd)
      throw Failure(message: "bind(\(path)): \(String(cString: strerror(bindError)))")
    }
    chmod(path, 0o600)
    guard Darwin.listen(fd, backlog) == 0 else {
      let message = String(cString: strerror(errno))
      close(fd)
      unlink(path)
      throw Failure(message: "listen(\(path)): \(message)")
    }
    return fd
  }
}

/// Counts clients and in-flight ops and decides when an idle helper should exit. The clock is injected so the timer
/// logic is testable.
final class IdleTracker: OpObserver, @unchecked Sendable {
  private let lock = NSLock()
  private let timeout: TimeInterval
  private let now: @Sendable () -> TimeInterval
  private var clients = 0
  private var inflight: [String: Int] = [:]
  private var lastBusy: TimeInterval

  /// `timeout` seconds of no clients and no in-flight ops end the process; 0 disables idle exit.
  init(timeout: TimeInterval, now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.timeout = timeout
    self.now = now
    self.lastBusy = now()
  }

  var clientCount: Int { lock.withLock { clients } }
  var inflightCount: Int { lock.withLock { inflight.values.reduce(0, +) } }

  func connectionOpened() {
    lock.withLock {
      clients += 1
      lastBusy = now()
    }
  }

  func connectionClosed() {
    lock.withLock {
      clients = max(0, clients - 1)
      lastBusy = now()
    }
  }

  func opStarted(key: String) {
    lock.withLock {
      inflight[key, default: 0] += 1
      lastBusy = now()
    }
  }

  func opFinished(key: String) {
    lock.withLock {
      if let count = inflight[key], count > 1 { inflight[key] = count - 1 } else { inflight[key] = nil }
      lastBusy = now()
    }
  }

  /// True once nothing has been connected or running for `timeout` seconds.
  func isExpired() -> Bool {
    lock.withLock {
      guard timeout > 0, clients == 0, inflight.isEmpty else { return false }
      return now() - lastBusy >= timeout
    }
  }
}

/// What `health` reports about the socket: where it listens and how many clients are attached.
final class SocketStatus: @unchecked Sendable {
  private let lock = NSLock()
  private var path: String?
  private var tracker: IdleTracker?

  func attach(path: String, tracker: IdleTracker) {
    lock.withLock {
      self.path = path
      self.tracker = tracker
    }
  }

  var json: JSON? {
    lock.withLock {
      guard let path, let tracker else { return nil }
      return ["path": .string(path), "clients": .int(tracker.clientCount)]
    }
  }
}

enum StopReason: String, Sendable, Equatable {
  case shutdown
  case idle
  case signal
}

/// Resolves once, with the first reason offered.
final class StopGate: @unchecked Sendable {
  private let lock = NSLock()
  private var reason: StopReason?
  private var waiter: CheckedContinuation<StopReason, Never>?

  func fire(_ new: StopReason) {
    let toResume: CheckedContinuation<StopReason, Never>? = lock.withLock {
      guard reason == nil else { return nil }
      reason = new
      defer { waiter = nil }
      return waiter
    }
    toResume?.resume(returning: new)
  }

  func wait() async -> StopReason {
    await withCheckedContinuation { continuation in
      let ready: StopReason? = lock.withLock {
        if let reason { return reason }
        waiter = continuation
        return nil
      }
      if let ready { continuation.resume(returning: ready) }
    }
  }
}

final class SocketServer<Context: Sendable>: @unchecked Sendable {
  let path: String
  private let dispatcher: Dispatcher<Context>
  private let context: Context
  private let ready: @Sendable () -> [String: JSON]
  private let tracker: IdleTracker
  private let mapError: @Sendable (any Error) -> WireError
  private let pollInterval: TimeInterval
  private let gate = StopGate()

  private let lock = NSLock()
  private var listenFD: Int32 = -1
  private var stopped = false
  private var nextConnection = 0
  private var clientFDs: Set<Int32> = []

  init(
    path: String, dispatcher: Dispatcher<Context>, context: Context, tracker: IdleTracker,
    ready: @escaping @Sendable () -> [String: JSON],
    mapError: @escaping @Sendable (any Error) -> WireError = { WireError.from($0) },
    pollInterval: TimeInterval = 0.1
  ) {
    self.path = path
    self.dispatcher = dispatcher
    self.context = context
    self.tracker = tracker
    self.ready = ready
    self.mapError = mapError
    self.pollInterval = pollInterval
  }

  /// Binds the socket and starts accepting. Throws `UnixSocket.Failure`.
  func start() throws {
    // A client that vanishes mid-write must cost an EPIPE, not the process (setsockopt(SO_NOSIGPIPE) fails with
    // EINVAL on a socket whose peer already closed, so it cannot be the only guard).
    signal(SIGPIPE, SIG_IGN)
    let fd = try UnixSocket.listen(path: path)
    lock.withLock { listenFD = fd }
    let thread = Thread { [self] in acceptLoop(fd) }
    thread.name = "warden-simd.accept"
    thread.start()
  }

  /// Blocks (asynchronously) until an op named `shutdown` was answered, the idle timer expired, or `requestStop`.
  func run() async -> StopReason {
    let watcher = Task { [self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(pollInterval))
        if tracker.isExpired() { gate.fire(.idle) }
      }
    }
    let reason = await gate.wait()
    watcher.cancel()
    stop()
    return reason
  }

  func requestStop(_ reason: StopReason) { gate.fire(reason) }

  /// Closes the listener, unlinks the socket file and drops every client.
  func stop() {
    let (listener, clients): (Int32, Set<Int32>) = lock.withLock {
      guard !stopped else { return (-1, []) }
      stopped = true
      return (listenFD, clientFDs)
    }
    guard listener >= 0 else { return }
    close(listener)
    unlink(path)
    for client in clients { Darwin.shutdown(client, SHUT_RDWR) }
  }

  private var isStopped: Bool { lock.withLock { stopped } }

  private func acceptLoop(_ fd: Int32) {
    while !isStopped {
      var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&descriptor, 1, 200)
      if ready <= 0 { continue }
      let client = accept(fd, nil, nil)
      if client < 0 { continue }
      var noSigPipe: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
      serve(client: client)
    }
  }

  private func serve(client fd: Int32) {
    let id: String = lock.withLock {
      nextConnection += 1
      clientFDs.insert(fd)
      return "c\(nextConnection)"
    }
    tracker.connectionOpened()
    let output = OutputChannel.fileDescriptor(fd)
    let readerExited = DispatchSemaphore(value: 0)
    let server = StdioServer(
      dispatcher: dispatcher, context: context, output: output, mapError: mapError, connectionID: id,
      observer: tracker, onShutdown: { [gate] in gate.fire(.shutdown) })
    let ready = self.ready
    Task.detached { [self] in
      output.send(.ready(ready()))
      _ = await server.run(input: stdinChunks(fd: fd, onExit: { readerExited.signal() }))
      output.close()
      tracker.connectionClosed()
      // Wake a reader still blocked in read(2), then close only once it can no longer touch the descriptor.
      Darwin.shutdown(fd, SHUT_RDWR)
      DispatchQueue.global().async { [self] in
        readerExited.wait()
        lock.withLock { _ = clientFDs.remove(fd) }
        close(fd)
      }
    }
  }
}
