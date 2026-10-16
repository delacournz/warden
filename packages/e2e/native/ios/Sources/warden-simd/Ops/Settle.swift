import FBSimulatorAX
import Foundation

enum SettleOps {
  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "settle": { session, params in
      try await session.settle(SettleRequest(params))
    }
  ]
}

/// `settle{quietMs=250, timeoutMs=3000, bundleId?}`.
///
/// The envelope's `timeoutMs` and the op's budget are the same key, and the TS client overwrites the latter with the
/// former (plus a margin). `settleTimeoutMs` therefore wins when present, so a client can keep a transport margin
/// without lengthening the wait.
///
/// With `bundleId`, quiet only counts once that application is the frontmost one: right after `launch` the
/// frontmost app is still the previous one (SpringBoard), which is already quiet. At the deadline without a match the
/// reply is `quiet:false, reason:"frontmost_mismatch"`.
struct SettleRequest: Equatable {
  static let defaultQuietMs = 250
  static let defaultTimeoutMs = 3000

  var quietMs: Int
  var timeoutMs: Int
  var bundleId: String?

  init(_ params: JSON) throws {
    if let raw = params["bundleId"], raw != .null {
      guard let id = raw.stringValue, !id.isEmpty else {
        throw WireError(.badRequest, "\"bundleId\" must be a non-empty string")
      }
      bundleId = id
    }
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

/// Whether the stream's frontmost process is the application a caller named. The named bundle's pid comes from
/// launchd (slow, so re-asked at most every `resolveEveryMs` and only while the two disagree); the frontmost pid
/// comes from the quiescence stream. Pure: the resolver and the clock are fed in.
struct FrontmostGate: Equatable {
  static let resolveEveryMs = 150

  let bundleId: String
  private(set) var targetPid: pid_t?
  private var lastResolveAt: Double?

  init(bundleId: String) {
    self.bundleId = bundleId
  }

  func matches(frontmostPid: pid_t?) -> Bool {
    guard let targetPid, let frontmostPid else { return false }
    return targetPid == frontmostPid
  }

  func shouldResolve(frontmostPid: pid_t?, now: Double) -> Bool {
    if matches(frontmostPid: frontmostPid) { return false }
    guard let lastResolveAt else { return true }
    return (now - lastResolveAt) * 1000 >= Double(Self.resolveEveryMs)
  }

  /// `pid` is nil while the application is not running (a launch still in flight).
  mutating func resolved(pid: pid_t?, now: Double) {
    if pid != targetPid { pidSince = pid == nil ? nil : now }
    targetPid = pid
    lastResolveAt = now
  }

  /// The stream is latched on a stale process when the bundle has a pid and the stream still reports another one.
  /// It is restarted only then, never while the bundle has no pid yet (a stream opened mid-launch binds to the
  /// previous frontmost app, which is exactly the latch being repaired): `firstRestartGraceMs` after the new pid
  /// appeared (a healthy stream follows within that), then every `repeatRestartMs` while it is still latched
  /// (a fresh stream takes ~0.6 s to bind).
  static let firstRestartGraceMs = 500
  static let repeatRestartMs = 1500

  private var pidSince: Double?
  private var lastRestartAt: Double?

  func shouldRestart(frontmostPid: pid_t?, now: Double) -> Bool {
    guard targetPid != nil, let pidSince, !matches(frontmostPid: frontmostPid) else { return false }
    guard let lastRestartAt, lastRestartAt >= pidSince else {
      return (now - pidSince) * 1000 >= Double(Self.firstRestartGraceMs)
    }
    return (now - lastRestartAt) * 1000 >= Double(Self.repeatRestartMs)
  }

  mutating func restarted(now: Double) {
    lastRestartAt = now
  }
}

/// Maps a bundle id to the pid of its running process, nil when it is not running.
typealias PidResolver = @Sendable (String) async -> pid_t?

/// A long-lived quiescence stream on the frontmost app. Opening a stream costs ~500-650 ms (guest connection +
/// display routing), so `settle` reads the stream's latest state instead of opening one per call. The guest reports
/// with a short window (50 ms); the caller's `quietMs` is measured here from the moment `quiet` was entered.
actor QuiescenceMonitor {
  private let reader: any UIAutomation
  private var task: Task<Void, Never>?
  private var state: QuiescenceState?
  /// The process the stream last reported on: the frontmost application.
  private var frontmostPid: pid_t?
  private var since: Double = 0
  private var lastError: (any Error)?
  private var lastUsed: Double = 0
  private var idleWatch: Task<Void, Never>?
  /// Close the stream after this long without a `settle`; nil keeps it open for the helper's lifetime.
  private let idleCloseSeconds: Double?

  init(reader: any UIAutomation, idleCloseSeconds: Double? = QuiescenceMonitor.configuredIdleCloseSeconds()) {
    self.reader = reader
    self.idleCloseSeconds = idleCloseSeconds
  }

  /// `WARDEN_SIMD_STREAM_IDLE_S=<seconds>` closes an idle stream after that long; unset or `0` keeps it open.
  static func configuredIdleCloseSeconds(
    _ environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Double? {
    guard let raw = environment["WARDEN_SIMD_STREAM_IDLE_S"], let seconds = Double(raw), seconds > 0 else { return nil }
    return seconds
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
          await self?.markOpening()
          let events = try await self?.reader.quiescence(
            .frontmost, parameters: QuiescenceParameters(quietWindow: 0.05))
          guard let events else { return }
          Self.trace("stream open")
          if !Task.isCancelled { await self?.markOpen() }
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
    frontmostPid = nil
    streamOpen = false
    openingSince = nil
    openedAt = nil
  }

  /// By default the stream stays open for the helper's lifetime: the guest binds it to whatever is frontmost
  /// (reporting `targetChanged`), and an app relaunched while no stream is open is unreadable by `axbridge` until
  /// one binds to it (see `recover`). The cost is that a stream competes with any other quiescence stream on the
  /// same simulator (a second helper, another agent's run: two concurrent streams leave each other stuck at
  /// `busy(runLoopIdle, animationsInactive)`); leases keep that to one helper per simulator, and
  /// `WARDEN_SIMD_STREAM_IDLE_S` closes an idle stream after that long (the next `settle` reopens it).
  private func startIdleWatch() {
    guard idleCloseSeconds != nil, idleWatch == nil else { return }
    idleWatch = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(250))
        await self?.closeIfIdle()
      }
    }
  }

  private func closeIfIdle() {
    guard let idleCloseSeconds, task != nil, Self.clock() - lastUsed >= idleCloseSeconds else { return }
    Self.trace("stream idle for \(idleCloseSeconds) s, closing")
    stop()
  }

  private func apply(_ event: QuiescenceEvent) {
    Self.trace("event \(event)")
    switch event {
    case let .state(new, pid):
      state = new
      frontmostPid = pid
      since = Self.clock()
      lastError = nil
    case let .targetChanged(pid):
      state = nil
      frontmostPid = pid
    case .targetExited:
      state = nil
      frontmostPid = nil
    case let .touchesCompleted(pid):
      frontmostPid = pid
    @unknown default:
      break
    }
  }

  private func failed(_ error: any Error) { lastError = error }
  private func reset() {
    state = nil
    frontmostPid = nil
    streamOpen = false
    openingSince = nil
    openedAt = nil
  }

  /// When the current stream began opening, nil once it is open (or closed). Opening costs 0.5 s on a quiet machine
  /// and seconds on a loaded one; a stream still opening has not latched on anything yet.
  private var openingSince: Double?
  private var streamOpen = false
  /// When the current stream finished opening; a stream reports its target a little after that.
  private var openedAt: Double?
  static let openingPatienceSeconds = 4.0
  /// How long a freshly opened stream gets to report its first frontmost pid before it can count as latched.
  static let bindGraceSeconds = 0.5

  private func markOpening() {
    openingSince = Self.clock()
    openedAt = nil
    streamOpen = false
  }

  private func markOpen() {
    openingSince = nil
    openedAt = Self.clock()
    streamOpen = true
  }

  /// Restarting a stream that is still opening (for up to `openingPatienceSeconds`) only throws that work away, and
  /// one that opened under `bindGraceSeconds` ago and has not reported a pid yet is still binding, not latched
  /// (observed live: a stream restarted 3 ms after it opened because the bundle's pid was already old).
  private func isStillOpening(now: Double) -> Bool {
    if !streamOpen, let openingSince { return now - openingSince < Self.openingPatienceSeconds }
    if streamOpen, frontmostPid == nil, let openedAt { return now - openedAt < Self.bindGraceSeconds }
    return false
  }

  private func snapshot() -> (state: QuiescenceState?, since: Double, error: (any Error)?, pid: pid_t?) {
    (state, since, lastError, frontmostPid)
  }

  /// The process the stream last reported on (the frontmost application); nil while no stream has reported.
  func currentFrontmostPid() -> pid_t? { frontmostPid }

  /// Closes the current stream and opens a fresh one; the next events describe the app from scratch.
  func restart() {
    Self.trace("stream restart")
    task?.cancel()
    task = nil
    state = nil
    frontmostPid = nil
    markOpening()
    start()
  }

  /// Opens a fresh stream and waits until it has reported on the frontmost app (or `timeoutMs` passes).
  ///
  /// This is what makes the bridge able to read an app that was relaunched while no stream was open: the guest
  /// only attaches to a new process once a stream has bound to it, so every read of that process times out with
  /// "did not respond" until then (`settle` repairs it for the same reason).
  func recover(timeoutMs: Int) async {
    restart()
    let deadline = Self.clock() + Double(timeoutMs) / 1000
    while state == nil, Self.clock() < deadline, !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(25))
    }
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
    /// Why `quiet` is false when it is not simply "still busy": `frontmost_mismatch`.
    var reason: String? = nil
    /// The frontmost pid at the end of the wait (set when a bundle id was asked for).
    var frontmostPid: pid_t? = nil
  }

  /// Quiet once the app has been quiet for `quietMs`, counted from no earlier than this call (a cached `quiet` may
  /// predate an action whose animation the stream has not reported yet); `quiet:false` at the deadline. A stream
  /// that never produced a state and keeps failing surfaces its error rather than a misleading `false`. A stream
  /// stuck with every signal unanswered is restarted once, then replaced by the snapshot-stability fallback (see
  /// `SettleJudge`).
  ///
  /// With `bundleId` and a `resolvePid`, nothing counts as quiet until the stream's frontmost process is that
  /// bundle's process; otherwise the wait ends `quiet:false, reason:"frontmost_mismatch"`. A stream that still
  /// reports another process after `judge.restartAfterMs` is restarted once (it may have latched the old app).
  func waitQuiet(
    quietMs: Int, timeoutMs: Int, judge: SettleJudge = SettleJudge(), bundleId: String? = nil,
    resolvePid: PidResolver? = nil
  ) async throws -> Outcome {
    start()
    let begun = Self.clock()
    let deadline = begun + Double(timeoutMs) / 1000
    Self.trace(
      "settle begin quietMs=\(quietMs) timeoutMs=\(timeoutMs) bundleId=\(bundleId ?? "-") state=\(String(describing: state))"
    )
    var stuck = StuckTracker()
    var restarted = false
    var stability = FrameStability()
    var lastRead = 0.0
    var gate = bundleId.map { FrontmostGate(bundleId: $0) }
    while true {
      let (state, since, _, pid) = snapshot()
      let now = Self.clock()
      lastUsed = now
      if var current = gate, let resolvePid {
        if current.shouldResolve(frontmostPid: pid, now: now) {
          current.resolved(pid: await resolvePid(current.bundleId), now: Self.clock())
          gate = current
          Self.trace("settle resolved \(current.bundleId) -> \(String(describing: current.targetPid)) frontmost=\(String(describing: pid))")
        }
        if !current.matches(frontmostPid: pid) {
          if now >= deadline {
            Self.trace("settle deadline frontmost mismatch pid=\(String(describing: pid))")
            if state == nil, let error = lastError { throw error }
            return Outcome(quiet: false, via: "stream", reason: "frontmost_mismatch", frontmostPid: pid)
          }
          if !isStillOpening(now: now), current.shouldRestart(frontmostPid: pid, now: now) {
            Self.trace("settle frontmost \(String(describing: pid)) is stale (target \(String(describing: current.targetPid))), restarting the stream")
            current.restarted(now: now)
            gate = current
            restart()
          }
          try await Task.sleep(for: .milliseconds(15))
          continue
        }
      }
      let isQuiet = QuietClock.isSettled(state: state, since: max(since, begun), now: now, quietMs: quietMs)
      let stuckFor = stuck.observe(state, now: now)
      switch judge.decide(isQuiet: isQuiet, stuckForMs: stuckFor, restarted: restarted) {
      case .quiet:
        Self.trace("settle quiet after \(Int((now - begun) * 1000)) ms")
        return Outcome(quiet: true, via: "stream")
      case .restartStream:
        Self.trace("settle stream stuck for \(stuckFor ?? 0) ms, restarting it")
        restarted = true
        if var current = gate {
          current.restarted(now: now)
          gate = current
        }
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
    guard let reader = axBridgeReader else {
      throw WireError(.unsupported, "settle needs the axbridge backend (bridge: \(bridge.name))")
    }
    // The stream rides the same guest as `snapshot` and the other reads: that guest is already exclusive to this
    // helper (see `Session.open`), so no other process can leave it stuck. A second guest of our own was tried
    // and broke accessibility for any app relaunched while the stream was alive (the relaunched app answered
    // every request with a timeout or an empty tree), so there is exactly one guest per helper.
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
    let simulator = self.simulator
    let outcome = try await quiescenceMonitor().waitQuiet(
      quietMs: request.quietMs, timeoutMs: request.timeoutMs, bundleId: request.bundleId,
      resolvePid: { bundleId in try? await simulator.application.processID(forBundleID: bundleId) })
    let elapsed = (ContinuousClock.now - started).components
    let waitedMs = Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000)
    var reply: [String: JSON] = [
      "quiet": .bool(outcome.quiet), "waitedMs": .int(waitedMs), "via": .string(outcome.via),
    ]
    if let reason = outcome.reason { reply["reason"] = .string(reason) }
    if let pid = outcome.frontmostPid { reply["frontmostPid"] = .int(Int(pid)) }
    return .object(reply)
  }
}
