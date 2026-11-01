import Foundation

/// Serialised line writer. Responses and events from concurrent ops never interleave within a line.
/// `close()` turns later sends into no-ops, so a late response never lands on a reused file descriptor.
final class OutputChannel: @unchecked Sendable {
  private let lock = NSLock()
  private let sink: @Sendable (Data) -> Void
  private var closed = false

  init(sink: @escaping @Sendable (Data) -> Void) {
    self.sink = sink
  }

  /// Writes to a file descriptor, retrying short writes; a closed pipe drops the line.
  static func fileDescriptor(_ fd: Int32) -> OutputChannel {
    OutputChannel { data in
      data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
          let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
          if written < 0 {
            if errno == EINTR { continue }
            return
          }
          offset += written
        }
      }
    }
  }

  func send(_ json: JSON) {
    let line = NDJSON.encodeLine(json)
    lock.lock()
    defer { lock.unlock() }
    if !closed { sink(line) }
  }

  func close() {
    lock.lock()
    closed = true
    lock.unlock()
  }

  func send(_ response: Response) { send(response.json) }
  func send(_ event: Event) { send(event.json) }

  func log(_ level: LogLevel, _ message: String, op: String? = nil, id: String? = nil) {
    send(.log(level: level, message: message, op: op, id: id))
  }
}

/// Reads a file descriptor on a thread and exposes the bytes as an `AsyncStream`; the stream ends at EOF.
/// `onExit` runs on the reader thread once it will never touch `fd` again (safe point to `close(fd)`).
func stdinChunks(fd: Int32 = 0, onExit: (@Sendable () -> Void)? = nil) -> AsyncStream<Data> {
  AsyncStream { continuation in
    let thread = Thread {
      var buffer = [UInt8](repeating: 0, count: 64 * 1024)
      while true {
        let count = read(fd, &buffer, buffer.count)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { break }
        continuation.yield(Data(buffer[0..<count]))
      }
      continuation.finish()
      onExit?()
    }
    thread.name = "warden-simd.reader.\(fd)"
    thread.start()
  }
}

/// Sees every request in flight, keyed `"<connection>:<request id>"` so two clients using id `"1"` never collide.
/// The idle-exit logic and `health`'s client count hang off this.
protocol OpObserver: Sendable {
  func opStarted(key: String)
  func opFinished(key: String)
}

/// NDJSON over a byte stream: one request per line, one response per request (possibly out of order), events
/// pushed by the caller through the same `OutputChannel`. One instance serves one connection (or stdio).
struct StdioServer<Context: Sendable>: Sendable {
  let dispatcher: Dispatcher<Context>
  let context: Context
  let output: OutputChannel
  let mapError: @Sendable (any Error) -> WireError
  let connectionID: String
  let observer: (any OpObserver)?
  /// Called after a successful `shutdown` response has been written (socket mode ends the whole process here).
  let onShutdown: @Sendable () -> Void

  init(
    dispatcher: Dispatcher<Context>, context: Context, output: OutputChannel,
    mapError: @escaping @Sendable (any Error) -> WireError = { WireError.from($0) },
    connectionID: String = "stdio", observer: (any OpObserver)? = nil,
    onShutdown: @escaping @Sendable () -> Void = {}
  ) {
    self.dispatcher = dispatcher
    self.context = context
    self.output = output
    self.mapError = mapError
    self.connectionID = connectionID
    self.observer = observer
    self.onShutdown = onShutdown
  }

  /// Runs until the input ends (after in-flight ops finish) or an op named `shutdownOp` has been answered.
  func run(input: AsyncStream<Data>) async -> Int32 {
    let stop = StopSignal()
    let loop = Task {
      await withTaskGroup(of: Void.self) { group in
        var buffer = LineBuffer()
        for await chunk in input {
          for line in buffer.append(chunk) {
            group.addTask { await serve(line: line, stop: stop) }
          }
        }
        if let tail = buffer.flush() {
          group.addTask { await serve(line: tail, stop: stop) }
        }
      }
    }
    stop.onStop = { loop.cancel() }
    await loop.value
    return 0
  }

  private func serve(line: Data, stop: StopSignal) async {
    switch NDJSON.parseRequest(line: line) {
    case let .failure(failure):
      output.send(.failure(id: failure.id, error: failure.error))
    case let .success(request):
      let key = "\(connectionID):\(request.id)"
      observer?.opStarted(key: key)
      let response = await dispatcher.handle(request, context: context, mapError: mapError)
      output.send(response)
      observer?.opFinished(key: key)
      if request.op == Dispatcher<Context>.shutdownOp, case .success = response {
        stop.fire()
        onShutdown()
      }
    }
  }
}

private final class StopSignal: @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable () -> Void)?

  var onStop: (@Sendable () -> Void)? {
    get { lock.withLock { handler } }
    set { lock.withLock { handler = newValue } }
  }

  func fire() { onStop?() }
}
