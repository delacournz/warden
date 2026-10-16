import FBSimulatorAX
import Foundation

enum SettleOps {
  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "settle": { session, params in
      try await session.settle(SettleRequest(params))
    },
    "rebind": { session, params in
      try await session.rebind(RebindRequest(params))
    },
  ]
}

/// `rebind{bundleId, rebindTimeoutMs=4000}`: waits until the quiescence stream reports on that bundle's process.
///
/// The guest only attaches to a process once a stream has bound to it, and an `axbridge` read of a process nobody has
/// bound answers "did not respond" (a failed read, then a stream restart, ~1.3 s). A client that has just relaunched
/// its app calls this first, so its first read already finds the app bound. Like `settle` it spends its own budget
/// (`rebindTimeoutMs`, else the padded envelope `timeoutMs`) and answers `bound:false` at the deadline, not an error.
struct RebindRequest: Equatable {
  static let defaultTimeoutMs = 4000

  var bundleId: String
  var timeoutMs: Int

  init(_ params: JSON) throws {
    guard let id = params["bundleId"]?.stringValue, !id.isEmpty else {
      throw WireError(.badRequest, "\"bundleId\" must be a non-empty string")
    }
    bundleId = id
    func nonNegative(_ key: String) throws -> Int? {
      guard let raw = params[key], raw != .null else { return nil }
      guard let value = raw.intValue, value >= 0 else {
        throw WireError(.badRequest, "\"\(key)\" must be a non-negative integer")
      }
      return value
    }
    timeoutMs = try nonNegative("rebindTimeoutMs") ?? nonNegative("timeoutMs") ?? Self.defaultTimeoutMs
  }
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
///
/// A stream that is stuck right after a relaunch has not recovered on a restart in any measured run (the guest stays
/// at `busy(runLoopIdle, animationsInactive)` for every app until the helper's own guest is replaced), so the
/// fallback is the safety net that matters: it answers from two identical reads ~0.7 s + 0.25 s in, instead of the
/// 2 s + 0.25 s it used to wait before trusting them.
struct SettleJudge: Equatable {
  var restartAfterMs = 400
  var fallbackAfterMs = 700

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
  /// The gate's clock rules, injectable so a test can line them up without waiting seconds.
  ///
  /// - `resolveEveryMs`: how often launchd is asked for the bundle's pid while the stream disagrees.
  /// - `firstRestartGraceMs`: how long a stream gets to follow a new pid before it counts as latched on the old
  ///   process. Measured on a device: a healthy stream reports the relaunched app 0.25-0.4 s after its pid exists
  ///   and a first state about 0.3 s later, while a restarted one needs ~0.2 s to open plus ~1.2 s to attach to an
  ///   app that is still starting, so restarting early is slower than waiting; 900 ms leaves room for a loaded host.
  /// - `repeatRestartMs`: the back-off between restarts of a stream that is still latched.
  struct Timing: Equatable, Sendable {
    var resolveEveryMs = 150
    var firstRestartGraceMs = 900
    var repeatRestartMs = 1500
  }

  let bundleId: String
  let timing: Timing
  private(set) var targetPid: pid_t?
  private var lastResolveAt: Double?

  init(bundleId: String, timing: Timing = Timing()) {
    self.bundleId = bundleId
    self.timing = timing
  }

  func matches(frontmostPid: pid_t?) -> Bool {
    guard let targetPid, let frontmostPid else { return false }
    return targetPid == frontmostPid
  }

  func shouldResolve(frontmostPid: pid_t?, now: Double) -> Bool {
    if matches(frontmostPid: frontmostPid) { return false }
    guard let lastResolveAt else { return true }
    return (now - lastResolveAt) * 1000 >= Double(timing.resolveEveryMs)
  }

  /// `pid` is nil while the application is not running (a launch still in flight).
  mutating func resolved(pid: pid_t?, now: Double) {
    if pid != targetPid { pidSince = pid == nil ? nil : now }
    targetPid = pid
    lastResolveAt = now
  }

  /// The stream is latched on a stale process when the bundle has a pid and the stream still reports another one.
  /// It is restarted only then, never while the bundle has no pid yet (a stream opened mid-launch binds to the
  /// previous frontmost app, which is exactly the latch being repaired): `timing.firstRestartGraceMs` after the new
  /// pid appeared (a healthy stream follows within that), then every `timing.repeatRestartMs` while it is still
  /// latched (a fresh stream takes ~0.6 s to bind).
  private var pidSince: Double?
  private var lastRestartAt: Double?

  func shouldRestart(frontmostPid: pid_t?, now: Double) -> Bool {
    guard targetPid != nil, let pidSince, !matches(frontmostPid: frontmostPid) else { return false }
    guard let lastRestartAt, lastRestartAt >= pidSince else {
      return (now - pidSince) * 1000 >= Double(timing.firstRestartGraceMs)
    }
    return (now - lastRestartAt) * 1000 >= Double(timing.repeatRestartMs)
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
  ///
  /// The old stream's task is awaited before the new one is requested, so there are never two streams (each owns a
  /// guest process, and two on one simulator leave each other stuck). The old task may still be inside its open call
  /// (cancelling it does not abort the open), so this can take as long as that open does. Concurrent restarts leave
  /// exactly one replacement: whoever finds a stream already running after its wait has nothing left to do.
  func restart() async {
    Self.trace("stream restart")
    let old = task
    task = nil
    old?.cancel()
    state = nil
    frontmostPid = nil
    markOpening()
    await old?.value
    guard task == nil else { return }
    state = nil
    frontmostPid = nil
    markOpening()
    start()
  }

  /// How long `recover` lets a stream follow the process on its own before it restarts the stream (see
  /// `FrontmostGate.Timing.firstRestartGraceMs`).
  static let recoverFollowMs = 900

  /// Gets the guest bound to an app it cannot read yet, and waits until the stream has reported on it (or
  /// `timeoutMs` passes).
  ///
  /// This is what makes the bridge able to read an app that was relaunched while no stream was bound to it: the guest
  /// only attaches to a new process once a stream has bound to it, so every read of that process times out with
  /// "did not respond" until then (`settle` repairs it for the same reason). With the process `pid` that failed, a
  /// stream that reports on it within `recoverFollowMs` is left alone (it follows a relaunch by itself, in less time
  /// than a restarted one needs to attach); otherwise, and without a pid, the stream is restarted.
  func recover(pid: pid_t? = nil, timeoutMs: Int) async {
    start()
    let begun = Self.clock()
    let deadline = begun + Double(timeoutMs) / 1000
    if let pid {
      let follow = min(deadline, begun + Double(Self.recoverFollowMs) / 1000)
      while !Task.isCancelled, Self.clock() < follow {
        lastUsed = Self.clock()
        if frontmostPid == pid, state != nil { return }
        try? await Task.sleep(for: .milliseconds(15))
      }
    }
    await restart()
    while state == nil, Self.clock() < deadline, !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(25))
    }
  }

  struct BindOutcome: Equatable {
    let bound: Bool
    /// The stream's frontmost process when the call ended (the bundle's own process when `bound`).
    var pid: pid_t? = nil
    /// How many times the stream was restarted to get there (0 when it followed the app by itself).
    var restarts = 0
    /// Why `bound` is false: `no_process` (the bundle never had a process) or `timeout` (it had one, the stream never
    /// reported on it).
    var reason: String? = nil
  }

  /// Waits until the stream has reported a state for `bundleId`'s process: the app is bound, so a read of it works.
  ///
  /// The stream follows a relaunch by itself (`targetChanged`, then a state) a few hundred ms after the process
  /// appears, so it is only restarted when it still reports another process after the gate's grace (a latched
  /// stream). Everything the decision looks at is read after any await: the pid lookup is a launchd round trip.
  func bind(
    bundleId: String, timeoutMs: Int, resolvePid: PidResolver, gateTiming: FrontmostGate.Timing = FrontmostGate.Timing()
  ) async -> BindOutcome {
    start()
    let deadline = Self.clock() + Double(timeoutMs) / 1000
    var gate = FrontmostGate(bundleId: bundleId, timing: gateTiming)
    var restarts = 0
    Self.trace("bind begin bundleId=\(bundleId) timeoutMs=\(timeoutMs) state=\(String(describing: state))")
    while !Task.isCancelled {
      lastUsed = Self.clock()
      var (current, _, _, pid) = snapshot()
      if gate.shouldResolve(frontmostPid: pid, now: Self.clock()) {
        gate.resolved(pid: await resolvePid(bundleId), now: Self.clock())
        Self.trace("bind resolved \(bundleId) -> \(String(describing: gate.targetPid))")
        (current, _, _, pid) = snapshot()
      }
      let now = Self.clock()
      if gate.matches(frontmostPid: pid), current != nil {
        Self.trace("bind bound pid=\(String(describing: pid)) restarts=\(restarts)")
        return BindOutcome(bound: true, pid: pid, restarts: restarts)
      }
      if now >= deadline {
        Self.trace("bind deadline pid=\(String(describing: pid)) target=\(String(describing: gate.targetPid))")
        return BindOutcome(
          bound: false, pid: pid, restarts: restarts, reason: gate.targetPid == nil ? "no_process" : "timeout")
      }
      if !isStillOpening(now: now), gate.shouldRestart(frontmostPid: pid, now: now) {
        Self.trace("bind frontmost \(String(describing: pid)) is stale (target \(String(describing: gate.targetPid))), restarting the stream")
        gate.restarted(now: now)
        restarts += 1
        await restart()
        continue
      }
      try? await Task.sleep(for: .milliseconds(15))
    }
    return BindOutcome(bound: false, pid: frontmostPid, restarts: restarts, reason: "cancelled")
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
    resolvePid: PidResolver? = nil, gateTiming: FrontmostGate.Timing = FrontmostGate.Timing()
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
    var gate = bundleId.map { FrontmostGate(bundleId: $0, timing: gateTiming) }
    while true {
      var (state, since, _, pid) = snapshot()
      var now = Self.clock()
      lastUsed = now
      if var current = gate, let resolvePid {
        if current.shouldResolve(frontmostPid: pid, now: now) {
          current.resolved(pid: await resolvePid(current.bundleId), now: Self.clock())
          gate = current
          Self.trace("settle resolved \(current.bundleId) -> \(String(describing: current.targetPid)) frontmost=\(String(describing: pid))")
          // the lookup is a launchd round trip: the stream may have followed the app while it was in flight, and
          // every decision below must see what it says now (a restart decided on the old pid threw away a stream that
          // had already bound to the app)
          (state, since, _, pid) = snapshot()
          now = Self.clock()
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
            await restart()
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
        await restart()
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
/// When a quiescence stream that reports every process busy should cost the simulator's AX guests.
///
/// Observed live: after some number of app relaunches the helper's long-lived guest (the one started with the helper)
/// answers every quiescence query with `busy(runLoopIdle, animationsInactive)`, for SpringBoard and every app, through
/// any number of stream restarts and a replaced reader, until that guest process is killed. Reads (`snapshot`) are
/// unaffected, so `settle` falls back to comparing snapshots (`via: "snapshot"`) and every later settle waits out the
/// stuck-stream window first.
///
/// A fallback is only evidence of a wedged guest when this guest generation has already shown it can report quiet;
/// otherwise the app is just busy (a spinner) and fresh guests would fall back the same way. The interval keeps a
/// screen that really never settles from killing guests back to back.
struct WedgePolicy: Equatable, Sendable {
  var minIntervalSeconds = 5.0

  func shouldReap(streamQuiets: Int, lastReapedAt: Double?, now: Double) -> Bool {
    guard streamQuiets > 0 else { return false }
    guard let lastReapedAt else { return true }
    return now - lastReapedAt >= minIntervalSeconds
  }
}

/// What `WedgePolicy` needs to know, per helper: quiet verdicts the stream gave since the guests were last reaped.
final class WedgeWatch: @unchecked Sendable {
  private let lock = NSLock()
  private var streamQuiets = 0
  private var lastReapedAt: Double?
  private var reapCount = 0

  /// A settle the stream answered quiet: the current guests can report quiescence.
  func noteStreamQuiet() { lock.withLock { streamQuiets += 1 } }

  func wantsReap(policy: WedgePolicy = WedgePolicy(), now: Double = ProcessInfo.processInfo.systemUptime) -> Bool {
    lock.withLock { policy.shouldReap(streamQuiets: streamQuiets, lastReapedAt: lastReapedAt, now: now) }
  }

  func didReap(now: Double = ProcessInfo.processInfo.systemUptime) {
    lock.withLock {
      streamQuiets = 0
      lastReapedAt = now
      reapCount += 1
    }
  }

  var reaps: Int { lock.withLock { reapCount } }
}

/// One process as `ps` lists it.
struct ProcessEntry: Equatable, Sendable {
  let pid: pid_t
  let ppid: pid_t
  let command: String
}

/// Finds and ends the in-guest AX bridge processes (`SimulatorFrameworkBridge-iOS serve`) of one simulator: they are
/// the children of its `launchd_sim`, whose command line names the device directory. idb respawns an ended guest on
/// the next read and the quiescence stream reopens on one, so ending every guest of the simulator is how a wedged one
/// is cleared (it cannot be told apart from its stream's guest by its command line).
struct GuestReaper: Sendable {
  var list: @Sendable () -> [ProcessEntry]
  var end: @Sendable (pid_t) -> Void

  static let guestMarker = "SimulatorFrameworkBridge-iOS serve"

  /// The guests that belong to simulator `udid` among `processes`; empty when the simulator's `launchd_sim` is not
  /// there (never matches another simulator's guests, whose parent is another `launchd_sim`).
  static func guests(of udid: String, in processes: [ProcessEntry]) -> [pid_t] {
    let launchd = processes.filter { $0.command.contains("launchd_sim") && $0.command.contains("/Devices/\(udid)/") }
    let parents = Set(launchd.map(\.pid))
    guard !parents.isEmpty else { return [] }
    return processes.filter { parents.contains($0.ppid) && $0.command.contains(guestMarker) }.map(\.pid)
  }

  /// Ends the guests of `udid`; returns the pids it signalled.
  @discardableResult
  func reap(udid: String) -> [pid_t] {
    let pids = Self.guests(of: udid, in: list())
    for pid in pids { end(pid) }
    return pids
  }

  /// Parses `ps -axo pid=,ppid=,command=` output.
  static func parse(_ output: String) -> [ProcessEntry] {
    output.split(separator: "\n").compactMap { line in
      let parts = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
      guard parts.count == 3, let pid = pid_t(parts[0]), let ppid = pid_t(parts[1]) else { return nil }
      return ProcessEntry(pid: pid, ppid: ppid, command: parts[2].trimmingCharacters(in: .whitespaces))
    }
  }

  static let system = GuestReaper(
    list: {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/ps")
      process.arguments = ["-axo", "pid=,ppid=,command="]
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = FileHandle.nullDevice
      guard (try? process.run()) != nil else { return [] }
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return parse(String(decoding: data, as: UTF8.self))
    },
    end: { pid in _ = Darwin.kill(pid, SIGTERM) })
}

/// Lazily creates the session's monitor on first use.
final class QuiescenceHolder: @unchecked Sendable {
  private let lock = NSLock()
  let wedge = WedgeWatch()
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

  /// The monitor if one was created; replacing a guest does not create one.
  var existing: QuiescenceMonitor? { lock.withLock { monitor } }
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
    let outcome = try await quiescenceMonitor().waitQuiet(
      quietMs: request.quietMs, timeoutMs: request.timeoutMs, bundleId: request.bundleId,
      resolvePid: { bundleId in await self.resolveBundlePid(bundleId) })
    let waitedMs = Session.elapsedMs(since: started)
    if outcome.quiet, outcome.via == "stream" { quiescence.wedge.noteStreamQuiet() }
    if outcome.via == "snapshot" { await reapWedgedGuests() }
    var reply: [String: JSON] = ["quiet": .bool(outcome.quiet), "waitedMs": .int(waitedMs), "via": .string(outcome.via)]
    if let reason = outcome.reason { reply["reason"] = .string(reason) }
    if let pid = outcome.frontmostPid { reply["frontmostPid"] = .int(Int(pid)) }
    return .object(reply)
  }

  /// Ends the simulator's AX guests when a settle fell back to snapshots on guests that used to report quiet (see
  /// `WedgePolicy`) and reopens the stream, which starts a fresh guest. Reads in flight fail and are retried by the
  /// caller's recovery; this runs after the settle's own verdict, so its wait is not charged to it.
  func reapWedgedGuests(reaper: GuestReaper = .system) async {
    let wedge = quiescence.wedge
    guard wedge.wantsReap(), let monitor = quiescence.existing else { return }
    let reaped = reaper.reap(udid: udid)
    guard !reaped.isEmpty else { return }
    wedge.didReap()
    OpLog.shared.log(
      .info, "quiescence stuck on every process; ended \(reaped.count) AX guest(s) (reap \(wedge.reaps))", op: "settle")
    try? await Task.sleep(for: .milliseconds(150))
    await monitor.restart()
  }

  /// `rebind{bundleId, rebindTimeoutMs}`: waits until the quiescence stream has reported on the bundle's process, so
  /// the first read of a relaunched app finds it bound (see `RebindRequest`). `{bound, waitedMs, restarts, pid?,
  /// reason?}`; `bound:false` at the deadline is an answer, not an error. Only the axbridge backend has a stream.
  func rebind(_ request: RebindRequest) async throws -> JSON {
    guard axDefault == "axbridge", axBridgeReader != nil else {
      throw WireError(.unsupported, "rebind needs the axbridge backend (ax: \(axDefault), bridge: \(bridge.name))")
    }
    let started = ContinuousClock.now
    // A launch makes the remembered pid (and the launched-before pid `frontmost` compares with) stale: forget it, the
    // lookups below remember the new process.
    bundlePids.remember(nil, for: request.bundleId)
    let outcome = try await quiescenceMonitor().bind(
      bundleId: request.bundleId, timeoutMs: request.timeoutMs,
      resolvePid: { bundleId in await self.resolveBundlePid(bundleId) })
    var reply: [String: JSON] = [
      "bound": .bool(outcome.bound), "waitedMs": .int(Session.elapsedMs(since: started)),
      "restarts": .int(outcome.restarts),
    ]
    if let pid = outcome.pid { reply["pid"] = .int(Int(pid)) }
    if let reason = outcome.reason { reply["reason"] = .string(reason) }
    return .object(reply)
  }

  static func elapsedMs(since started: ContinuousClock.Instant) -> Int {
    let elapsed = (ContinuousClock.now - started).components
    return Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000)
  }
}
