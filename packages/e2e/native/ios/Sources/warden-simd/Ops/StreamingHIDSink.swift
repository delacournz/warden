import FBSimulatorControl
import Foundation

/// Where live touch sends its HID events: one at a time, each call returning once the event was delivered.
protocol LiveHIDSink: Sendable {
  func send(_ event: SimulatorHIDEvent) async throws
  /// The gesture is over (no finger down): close whatever the sink keeps open.
  func end() async
}

/// One HID operation per event (tests, and the fallback shape): `send` is the environment's.
struct PerEventHIDSink: LiveHIDSink {
  let environment: InputEnvironment

  func send(_ event: SimulatorHIDEvent) async throws {
    let environment = environment
    try await environment.gate.run { try await environment.send(event) }
  }

  func end() async {}
}

/// The events of one open HID operation. idb's `send(events:)` asks for the next event only after it delivered the
/// one before, so each `next()` after the first confirms the previous event (`onDelivered`).
struct DeliveredHIDEvents: AsyncSequence, Sendable {
  typealias Element = SimulatorHIDEvent

  let stream: AsyncStream<SimulatorHIDEvent>
  let onDelivered: @Sendable () -> Void

  struct AsyncIterator: AsyncIteratorProtocol {
    var base: AsyncStream<SimulatorHIDEvent>.AsyncIterator
    let onDelivered: @Sendable () -> Void
    var handedOut = false

    mutating func next() async -> SimulatorHIDEvent? {
      if handedOut { onDelivered() }
      let event = await base.next()
      handedOut = event != nil
      return event
    }
  }

  func makeAsyncIterator() -> AsyncIterator {
    AsyncIterator(base: stream.makeAsyncIterator(), onDelivered: onDelivered)
  }
}

/// Keeps ONE HID operation open for a whole gesture and feeds each live event into it. A fresh `send(event:)` per
/// event is a whole HID operation (~8-9 ms each on a sim, measured), which a 60 Hz finger cannot afford; yielding into
/// an open `send(events:)` costs well under a millisecond. `run` is idb's `send(events:)`, under the HID gate, so
/// other input waits until the fingers lift (at most the 10 s stuck-finger limit). A failed operation fails the
/// waiting send and the next send opens a new one.
final class StreamingHIDSink: LiveHIDSink, @unchecked Sendable {
  typealias Run = @Sendable (DeliveredHIDEvents) async throws -> Void

  private final class Operation: @unchecked Sendable {
    let continuation: AsyncStream<SimulatorHIDEvent>.Continuation
    /// sends waiting for their event to be delivered, oldest first
    var waiting: [CheckedContinuation<Void, any Error>] = []
    var finished = false

    init(continuation: AsyncStream<SimulatorHIDEvent>.Continuation) {
      self.continuation = continuation
    }
  }

  private let run: Run
  private let lock = NSLock()
  private var current: Operation?

  init(run: @escaping Run) {
    self.run = run
  }

  /// idb's open-ended send through `gate`.
  static func hid(_ hid: SimulatorHID, gate: HIDGate) -> StreamingHIDSink {
    let logger = NullLogger()
    return StreamingHIDSink(run: { events in
      try await gate.run { try await hid.send(events: events, logger: logger) }
    })
  }

  func send(_ event: SimulatorHIDEvent) async throws {
    try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, any Error>) in
      lock.withLock {
        let operation = current ?? open()
        operation.waiting.append(waiter)
        operation.continuation.yield(event)
      }
    }
  }

  func end() async {
    let operation = lock.withLock {
      let operation = current
      current = nil
      return operation
    }
    operation?.continuation.finish()
  }

  /// Under `lock`: a new operation and the task that runs it.
  private func open() -> Operation {
    let (stream, continuation) = AsyncStream<SimulatorHIDEvent>.makeStream(bufferingPolicy: .unbounded)
    let operation = Operation(continuation: continuation)
    current = operation
    let events = DeliveredHIDEvents(stream: stream) { [weak self] in self?.delivered(operation) }
    let run = run
    Task { [weak self] in
      do {
        try await run(events)
        self?.close(operation, error: nil)
      } catch {
        self?.close(operation, error: error)
      }
    }
    return operation
  }

  private func delivered(_ operation: Operation) {
    let waiter = lock.withLock { operation.waiting.isEmpty ? nil : operation.waiting.removeFirst() }
    waiter?.resume()
  }

  /// The operation ended: anything still waiting was not delivered (an error) or was (a clean end).
  private func close(_ operation: Operation, error: (any Error)?) {
    let waiting = lock.withLock {
      operation.finished = true
      if current === operation { current = nil }
      let waiting = operation.waiting
      operation.waiting = []
      return waiting
    }
    operation.continuation.finish()
    for waiter in waiting {
      if let error { waiter.resume(throwing: error) } else { waiter.resume() }
    }
  }
}
