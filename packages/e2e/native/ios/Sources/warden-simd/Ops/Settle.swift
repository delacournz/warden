import FBSimulatorAX
import Foundation

enum SettleOps {
  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "settle": { session, params in
      try await session.settle(SettleRequest(params))
    }
  ]
}

/// `settle{quietMs=250, timeoutMs=3000}`.
///
/// The envelope's `timeoutMs` and the op's budget are the same key, and the TS client overwrites the latter with the
/// former (plus a margin). `settleTimeoutMs` therefore wins when present, so a client can keep a transport margin
/// without lengthening the wait.
struct SettleRequest: Equatable {
  static let defaultQuietMs = 250
  static let defaultTimeoutMs = 3000

  var quietMs: Int
  var timeoutMs: Int

  init(_ params: JSON) throws {
    func nonNegative(_ key: String) throws -> Int? {
      guard let raw = params[key], raw != .null else { return nil }
      guard let value = raw.intValue, value >= 0 else {
        throw WireError(.badRequest, "\"\(key)\" must be a non-negative integer")
      }
      return value
    }
    quietMs = try nonNegative("quietMs") ?? Self.defaultQuietMs
    timeoutMs = try nonNegative("settleTimeoutMs") ?? nonNegative("timeoutMs") ?? Self.defaultTimeoutMs
  }
}

/// Decides "quiet for at least `quietMs`" from the latest quiescence state and when it was entered. Pure, so the
/// timing rule is unit-testable without a simulator.
struct QuietClock: Equatable {
  /// Milliseconds the state has been `.quiet` as of `now`, or nil when it is anything else (or unknown).
  static func quietFor(state: QuiescenceState?, since: Double, now: Double) -> Double? {
    guard case .quiet = state else { return nil }
    return max(0, now - since) * 1000
  }

  static func isSettled(state: QuiescenceState?, since: Double, now: Double, quietMs: Int) -> Bool {
    guard let quiet = quietFor(state: state, since: since, now: now) else { return false }
    return quiet >= Double(quietMs)
  }
}

/// A long-lived quiescence stream on the frontmost app. Opening a stream costs ~500-650 ms (guest connection +
/// display routing), so `settle` reads the stream's latest state instead of opening one per call. The guest reports
/// with a short window (50 ms); the caller's `quietMs` is measured here from the moment `quiet` was entered.
actor QuiescenceMonitor {
  private let reader: any UIAutomation
  private var task: Task<Void, Never>?
  private var state: QuiescenceState?
  private var since: Double = 0
  private var lastError: (any Error)?

  init(reader: any UIAutomation) {
    self.reader = reader
  }

  private static func clock() -> Double { ProcessInfo.processInfo.systemUptime }

  func start() {
    guard task == nil else { return }
    task = Task { [weak self] in
      while !Task.isCancelled {
        do {
          let events = try await self?.reader.quiescence(
            .frontmost, parameters: QuiescenceParameters(quietWindow: 0.05))
          guard let events else { return }
          for try await event in events {
            await self?.apply(event)
          }
        } catch is CancellationError {
          return
        } catch {
          await self?.failed(error)
        }
        await self?.reset()
        try? await Task.sleep(for: .milliseconds(200))
      }
    }
  }

  func stop() {
    task?.cancel()
    task = nil
  }

  private func apply(_ event: QuiescenceEvent) {
    switch event {
    case let .state(new, _):
      state = new
      since = Self.clock()
      lastError = nil
    case .targetChanged, .targetExited:
      state = nil
    case .touchesCompleted:
      break
    @unknown default:
      break
    }
  }

  private func failed(_ error: any Error) { lastError = error }
  private func reset() { state = nil }

  private func snapshot() -> (state: QuiescenceState?, since: Double, error: (any Error)?) {
    (state, since, lastError)
  }

  /// True once the app has been quiet for `quietMs`, counted from no earlier than this call (a cached `quiet` may
  /// predate an action whose animation the stream has not reported yet); false at the deadline. A stream that never
  /// produced a state and
  /// keeps failing surfaces its error rather than a misleading `false`.
  func waitQuiet(quietMs: Int, timeoutMs: Int) async throws -> Bool {
    start()
    let begun = Self.clock()
    let deadline = begun + Double(timeoutMs) / 1000
    while true {
      let (state, since, _) = snapshot()
      let now = Self.clock()
      if QuietClock.isSettled(state: state, since: max(since, begun), now: now, quietMs: quietMs) { return true }
      if now >= deadline {
        if state == nil, let error = lastError { throw error }
        return false
      }
      try await Task.sleep(for: .milliseconds(15))
    }
  }
}

/// Lazily creates the session's monitor on first use.
final class QuiescenceHolder: @unchecked Sendable {
  private let lock = NSLock()
  private var monitor: QuiescenceMonitor?

  func get(_ make: () -> any UIAutomation) -> QuiescenceMonitor {
    lock.withLock {
      if let monitor { return monitor }
      let created = QuiescenceMonitor(reader: make())
      monitor = created
      return created
    }
  }

  func stop() async {
    let current = lock.withLock { monitor }
    await current?.stop()
  }
}

extension Session {
  /// Starts the monitor's stream in the background so the first `settle` is already warm. No-op without a bridge.
  func warmQuiescence() async {
    guard axDefault == "axbridge", let monitor = try? quiescenceMonitor() else { return }
    await monitor.start()
  }

  func quiescenceMonitor() throws -> QuiescenceMonitor {
    guard let reader = axBridgeReader else {
      throw WireError(.unsupported, "settle needs the axbridge backend (bridge: \(bridge.name))")
    }
    return quiescence.get { reader }
  }

  /// Waits until the frontmost app has been quiet (`run_loop_idle` + `animations_inactive` answered) for `quietMs`.
  /// Deadline reached → `{quiet:false}`, not an error. Only the axbridge backend can measure this: with the host
  /// `ax` backend (or no bridge) the answer is `E_UNSUPPORTED` and the TS side polls snapshot hashes instead.
  func settle(_ request: SettleRequest) async throws -> JSON {
    guard axDefault == "axbridge", axBridgeReader != nil else {
      throw WireError(.unsupported, "settle needs the axbridge backend (ax: \(axDefault), bridge: \(bridge.name))")
    }
    let started = ContinuousClock.now
    let quiet = try await quiescenceMonitor().waitQuiet(quietMs: request.quietMs, timeoutMs: request.timeoutMs)
    let elapsed = (ContinuousClock.now - started).components
    let waitedMs = Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000)
    return ["quiet": .bool(quiet), "waitedMs": .int(waitedMs)]
  }
}
