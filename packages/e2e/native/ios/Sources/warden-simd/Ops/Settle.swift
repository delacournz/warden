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

/// What `settle` does next. Pure so the stuck-stream policy is testable with an injected clock.
enum SettleDecision: Equatable {
  case quiet
  case wait
  /// Close the guest stream and open a fresh one (re-enables automation mode, re-asks every signal).
  case restartStream
  /// Stop trusting the stream: judge by two identical accessibility reads instead.
  case fallback
}

/// The stream is "stuck" when every signal is unanswered (`busy(runLoopIdle, animationsInactive)`): the app, or the
/// guest's link to it, is not answering at all. A real busy app answers at least one signal now and then, so a single
/// busy signal never counts. Stuck guests were observed on contended simulators; a fresh guest or a stream restart
/// is the remedy, the snapshot-stability fallback the last resort.
struct SettleJudge: Equatable {
  var restartAfterMs = 1000
  var fallbackAfterMs = 2000

  func decide(isQuiet: Bool, stuckForMs: Int?, restarted: Bool) -> SettleDecision {
    if isQuiet { return .quiet }
    guard let stuckForMs else { return .wait }
    if stuckForMs >= fallbackAfterMs { return .fallback }
    if stuckForMs >= restartAfterMs, !restarted { return .restartStream }
    return .wait
  }
}

/// How long the current call has seen the stream stuck. A responsive state (settling, quiet, a single busy signal)
/// resets it; "no state yet" (an app still launching) neither starts nor resets it.
struct StuckTracker: Equatable {
  private var startedAt: Double?

  static func isStuck(_ state: QuiescenceState?) -> Bool {
    guard case let .busy(signals) = state else { return false }
    return QuiescenceSignal.allCases.allSatisfy { signals.contains($0) }
  }

  mutating func observe(_ state: QuiescenceState?, now: Double) -> Int? {
    if Self.isStuck(state) {
      if startedAt == nil { startedAt = now }
    } else if state != nil {
      startedAt = nil
    }
    return startedAt.map { Int(max(0, now - $0) * 1000) }
  }
}

/// Two reads of the same tree at least `quietMs` apart count as settled. Pure; the reads are fed in.
struct FrameStability: Equatable {
  private var last: Data?
  private var since: Double = 0

  mutating func observe(_ frame: Data, now: Double, quietMs: Int) -> Bool {
    if frame != last {
      last = frame
      since = now
      return quietMs == 0
    }
    return (now - since) * 1000 >= Double(quietMs)
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
  private var lastUsed: Double = 0
  private var idleWatch: Task<Void, Never>?

  init(reader: any UIAutomation) {
    self.reader = reader
  }

  private static func clock() -> Double { ProcessInfo.processInfo.systemUptime }

  /// `--trace` / `WARDEN_SIMD_TRACE=1`: one `log` event per quiescence sample, stamped with uptime milliseconds.
  static var tracing: Bool { ProcessInfo.processInfo.environment["WARDEN_SIMD_TRACE"] == "1" }

  nonisolated static func trace(_ message: @autoclosure () -> String) {
    guard tracing else { return }
    OpLog.shared.log(.debug, "t=\(Int(clock() * 1000)) \(message())", op: "settle")
  }

  func start() {
    lastUsed = Self.clock()
    startIdleWatch()
    guard task == nil else { return }
    task = Task { [weak self] in
      while !Task.isCancelled {
        do {
          Self.trace("stream opening")
          let events = try await self?.reader.quiescence(
            .frontmost, parameters: QuiescenceParameters(quietWindow: 0.05))
          guard let events else { return }
          Self.trace("stream open")
          for try await event in events {
            await self?.apply(event)
          }
          Self.trace("stream ended")
        } catch is CancellationError {
          return
        } catch {
          Self.trace("stream failed: \(error)")
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
    idleWatch?.cancel()
    idleWatch = nil
    state = nil
  }

  /// A stream left open between calls competes with any other quiescence stream on the same simulator (a second
  /// helper, another agent's run): two concurrent streams leave each other stuck at `busy(runLoopIdle,
  /// animationsInactive)`. So the stream is closed once nothing has settled for `idleCloseSeconds`; the next
  /// `settle` reopens it.
  static let idleCloseSeconds = 10.0

  private func startIdleWatch() {
    guard idleWatch == nil else { return }
    idleWatch = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        await self?.closeIfIdle()
      }
    }
  }

  private func closeIfIdle() {
    guard task != nil, Self.clock() - lastUsed >= Self.idleCloseSeconds else { return }
    Self.trace("stream idle for \(Int(Self.idleCloseSeconds)) s, closing")
    stop()
  }

  private func apply(_ event: QuiescenceEvent) {
    Self.trace("event \(event)")
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

  /// Closes the current stream and opens a fresh one; the next events describe the app from scratch.
  func restart() {
    Self.trace("stream restart")
    task?.cancel()
    task = nil
    state = nil
    start()
  }

  /// One cheap tree read (the settle fallback's frame): the frontmost document encoded with sorted keys.
  private func readFrame() async throws -> Data {
    var options = AccessibilityRequestOptions(format: .complete, keys: [])
    options.filter = .all
    let document = try await reader.describe(.frontmost, options: options).document
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(document)
  }

  struct Outcome: Equatable {
    let quiet: Bool
    /// `stream` (the guest said quiet) or `snapshot` (the fallback judged two identical reads settled).
    let via: String
  }

  /// Quiet once the app has been quiet for `quietMs`, counted from no earlier than this call (a cached `quiet` may
  /// predate an action whose animation the stream has not reported yet); `quiet:false` at the deadline. A stream
  /// that never produced a state and keeps failing surfaces its error rather than a misleading `false`. A stream
  /// stuck with every signal unanswered is restarted once, then replaced by the snapshot-stability fallback (see
  /// `SettleJudge`).
  func waitQuiet(quietMs: Int, timeoutMs: Int, judge: SettleJudge = SettleJudge()) async throws -> Outcome {
    start()
    let begun = Self.clock()
    let deadline = begun + Double(timeoutMs) / 1000
    Self.trace("settle begin quietMs=\(quietMs) timeoutMs=\(timeoutMs) state=\(String(describing: state))")
    var stuck = StuckTracker()
    var restarted = false
    var stability = FrameStability()
    var lastRead = 0.0
    while true {
      let (state, since, _) = snapshot()
      let now = Self.clock()
      lastUsed = now
      let isQuiet = QuietClock.isSettled(state: state, since: max(since, begun), now: now, quietMs: quietMs)
      let stuckFor = stuck.observe(state, now: now)
      switch judge.decide(isQuiet: isQuiet, stuckForMs: stuckFor, restarted: restarted) {
      case .quiet:
        Self.trace("settle quiet after \(Int((now - begun) * 1000)) ms")
        return Outcome(quiet: true, via: "stream")
      case .restartStream:
        Self.trace("settle stream stuck for \(stuckFor ?? 0) ms, restarting it")
        restarted = true
        restart()
      case .fallback:
        if now - lastRead >= 0.1, let frame = try? await readFrame() {
          lastRead = Self.clock()
          if stability.observe(frame, now: lastRead, quietMs: max(quietMs, 150)) {
            Self.trace("settle quiet by snapshot stability after \(Int((lastRead - begun) * 1000)) ms")
            return Outcome(quiet: true, via: "snapshot")
          }
        }
      case .wait:
        break
      }
      if now >= deadline {
        Self.trace("settle deadline state=\(String(describing: state))")
        if state == nil, let error = lastError { throw error }
        return Outcome(quiet: false, via: "stream")
      }
      try await Task.sleep(for: .milliseconds(15))
    }
  }
}

/// Lazily creates the session's monitor on first use.
final class QuiescenceHolder: @unchecked Sendable {
  private let lock = NSLock()
  private var monitor: QuiescenceMonitor?

  func get(_ make: () throws -> any UIAutomation) rethrows -> QuiescenceMonitor {
    try lock.withLock {
      if let monitor { return monitor }
      let created = QuiescenceMonitor(reader: try make())
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
    guard axBridgeReader != nil else {
      throw WireError(.unsupported, "settle needs the axbridge backend (bridge: \(bridge.name))")
    }
    // The helper owns the simulator for its lifetime, so the long-lived stream gets a guest of its own: on the
    // shared guest it was left stuck (every signal unanswered) after another process held a stream there.
    return try quiescence.get {
      try simulator.uiAutomation(
        backend: .axBridge(persistence: .exclusive, frontmostMethod: .windowServer, automationMode: true))
    }
  }

  /// Waits until the frontmost app has been quiet (`run_loop_idle` + `animations_inactive` answered) for `quietMs`.
  /// Deadline reached → `{quiet:false}`, not an error. Only the axbridge backend can measure this: with the host
  /// `ax` backend (or no bridge) the answer is `E_UNSUPPORTED` and the TS side polls snapshot hashes instead.
  func settle(_ request: SettleRequest) async throws -> JSON {
    guard axDefault == "axbridge", axBridgeReader != nil else {
      throw WireError(.unsupported, "settle needs the axbridge backend (ax: \(axDefault), bridge: \(bridge.name))")
    }
    let started = ContinuousClock.now
    let outcome = try await quiescenceMonitor().waitQuiet(quietMs: request.quietMs, timeoutMs: request.timeoutMs)
    let elapsed = (ContinuousClock.now - started).components
    let waitedMs = Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000)
    return ["quiet": .bool(outcome.quiet), "waitedMs": .int(waitedMs), "via": .string(outcome.via)]
  }
}
