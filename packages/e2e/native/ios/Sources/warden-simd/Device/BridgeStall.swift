import Foundation

/// How long one `axbridge` read may take before it counts as a stalled guest, and how long the bridge is then skipped.
///
/// A guest that does not answer in time (seen on GitHub `macos-26` runners, 3 vCPU: a cold sim, or one booted beside a
/// local Xcode build, took 4-11 s for its first bridge read and every `snapshot` ended `E_TIMEOUT` at the client's 10 s) used to hang each read until the client's own timeout, with no fallback,
/// because only a bridge *error* fell back to the host `ax` reader. `readMs` turns the silence into a bridge failure
/// with time left for the `ax` read inside the client's 10 s; `cooldownSeconds` sends the reads that follow straight
/// to `ax`, so a dead guest costs one deadline, not one per read, and the bridge is probed again after it.
/// A healthy read takes 6-90 ms, ~200 ms first after a launch.
///
/// The slow first read is the guest warming up, not a dead guest, so a cold guest (just started, recycled, or the app
/// just relaunched; `BridgeWarmth`) gets `coldReadMs` instead, and its first stall does not arm the cooldown.
struct BridgeDeadline: Sendable, Equatable {
  /// The first read of a cold guest: past the 4-11 s seen on a 3-vCPU runner.
  static let defaultColdReadMs = 12_000

  /// `nil` = no deadline (`WARDEN_SIMD_BRIDGE_DEADLINE_MS=0`).
  var readMs: Int? = 4000
  /// The deadline while the guest is cold; `nil` = none. Never shorter than `readMs`.
  var coldReadMs: Int? = BridgeDeadline.defaultColdReadMs
  var cooldownSeconds: Double = 20

  init(readMs: Int? = 4000, coldReadMs: Int? = BridgeDeadline.defaultColdReadMs, cooldownSeconds: Double = 20) {
    self.readMs = readMs
    self.coldReadMs = coldReadMs
    self.cooldownSeconds = cooldownSeconds
  }

  /// The cold deadline in force: none when reads have none, never shorter than `readMs`.
  var coldDeadlineMs: Int? {
    guard let readMs, let coldReadMs else { return nil }
    return max(readMs, coldReadMs)
  }

  /// `WARDEN_SIMD_BRIDGE_DEADLINE_MS` (ms, `0` = off, cold reads included), `WARDEN_SIMD_BRIDGE_COLD_DEADLINE_MS`
  /// (ms, raised to the warm deadline) and `WARDEN_SIMD_BRIDGE_COOLDOWN_S` (seconds, `0` = never skip); anything
  /// that is not a non-negative number keeps the default.
  static func configured(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> BridgeDeadline {
    var policy = BridgeDeadline()
    if let raw = environment["WARDEN_SIMD_BRIDGE_DEADLINE_MS"], let ms = Int(raw), ms >= 0 {
      policy.readMs = ms == 0 ? nil : ms
    }
    if let raw = environment["WARDEN_SIMD_BRIDGE_COLD_DEADLINE_MS"], let ms = Int(raw), ms > 0 {
      policy.coldReadMs = ms
    }
    if let raw = environment["WARDEN_SIMD_BRIDGE_COOLDOWN_S"], let seconds = Double(raw), seconds >= 0 {
      policy.cooldownSeconds = seconds
    }
    policy.coldReadMs = policy.coldDeadlineMs
    return policy
  }
}

/// Whether the `axbridge` guest has answered a read since it last went cold (helper start, a guest recycle or reap, an
/// app launch). Each cold spell has a generation, so a read that started before the guest went cold cannot warm the
/// new one, and one stall that is exempt from the cooldown. `warmUp` is a single-flight read that runs in the
/// background, so the first read a caller makes finds the guest warm or joins the warm-up instead of starting a second
/// slow read.
final class BridgeWarmth: @unchecked Sendable {
  enum WarmUp: Sendable, Equatable {
    case warmed
    /// The guest did not answer within `afterMs`: the reads that joined go to `ax`.
    case stalled(afterMs: Int)
    /// The read failed for another reason (the reads that joined ask the bridge themselves).
    case failed
  }

  private let lock = NSLock()
  private var cold = true
  private var spell = 0
  private var exemptStallUsed = false
  private var inFlight: (spell: Int, task: Task<WarmUp, Never>)?

  init() {}

  /// A guest that already answered (tests).
  static func warmed() -> BridgeWarmth {
    let warmth = BridgeWarmth()
    warmth.noteSuccess(generation: warmth.generation)
    return warmth
  }

  var isCold: Bool { lock.withLock { cold } }
  var generation: Int { lock.withLock { spell } }

  /// The guest was replaced or the app relaunched: the next read is cold again, with a fresh exempt stall unless
  /// `exemptStall` is false. A guest replaced because it stalled gets none: its first read already has the cold
  /// deadline, and a second cold deadline on the read after it would charge a caller twice for one dead guest.
  func markCold(exemptStall: Bool = true) {
    lock.withLock {
      cold = true
      spell += 1
      exemptStallUsed = !exemptStall
      inFlight = nil
    }
  }

  /// A read started in `generation` answered; warms the guest when it is still that spell.
  func noteSuccess(generation: Int) {
    lock.withLock { if generation == spell { cold = false } }
  }

  /// A cold read stalled: whether this stall is the spell's exempt one (true once per spell; the cooldown is not armed).
  func takeExemptStall(generation: Int) -> Bool {
    lock.withLock {
      guard generation == spell, cold, !exemptStallUsed else { return false }
      exemptStallUsed = true
      return true
    }
  }

  /// The deadline for a bridge read right now.
  func deadlineMs(_ policy: BridgeDeadline) -> Int? {
    isCold ? policy.coldDeadlineMs : policy.readMs
  }

  /// Starts a background read while the guest is cold; joins the one in flight; nil when the guest is warm.
  @discardableResult
  func warmUp(
    deadlineMs: Int?, log: @escaping @Sendable (String) -> Void, read: @escaping @Sendable () async throws -> Void
  ) -> Task<WarmUp, Never>? {
    lock.withLock { () -> Task<WarmUp, Never>? in
      guard cold else { return nil }
      if let inFlight, inFlight.spell == spell { return inFlight.task }
      let generation = spell
      let started = ContinuousClock.now
      let task = Task<WarmUp, Never> { [weak self] in
        do {
          _ = try await Session.bounded({ try await read() }, deadlineMs: deadlineMs)
          self?.noteSuccess(generation: generation)
          log("axbridge warm-up answered in \(Session.elapsedMs(since: started)) ms")
          return .warmed
        } catch let stall as BridgeStalled {
          _ = self?.takeExemptStall(generation: generation)
          log("axbridge warm-up: \(stall.localizedDescription)")
          return .stalled(afterMs: stall.afterMs)
        } catch {
          log("axbridge warm-up failed: \(WireError.from(error).message)")
          return .failed
        }
      }
      inFlight = (generation, task)
      return task
    }
  }

  /// The outcome of the current spell's warm-up, waited for; nil when none ran or the guest has answered since (a
  /// recovery probe can warm a guest whose warm-up stalled).
  func joinWarmUp() async -> WarmUp? {
    guard let task = lock.withLock({ cold && inFlight?.spell == spell ? inFlight?.task : nil }) else { return nil }
    return await task.value
  }
}

/// A cheap check that the `axbridge` guest answers again, run in the background while reads are on `ax` (a stall
/// cooldown, or a cold guest whose warm-up stalled), so a guest that recovers is used again without a caller paying a
/// full tree read against the read deadline. Single-flight: reads that arrive while one runs join it. A new one starts
/// at most every `intervalNow`: `intervalSeconds`, doubled for each probe in a row that did not answer, capped at
/// `maxIntervalSeconds`, because a probe that is cut off takes its guest down with it (idb ends the guest of a
/// cancelled request) and every probe then starts a new one. Each probe is bounded by `deadlineMs`, short of a user
/// read's, unless the caller passes the cold deadline for a guest that is starting again.
final class BridgeProbe: @unchecked Sendable {
  /// One element answered is proof enough; a healthy one takes a few ms, a cold guest's first read up to seconds.
  static let defaultDeadlineMs = 1500
  /// The least time between two probes.
  static let defaultIntervalSeconds: Double = 5
  /// The most time between two probes while they stay silent.
  static let maxIntervalSeconds: Double = 30

  enum Outcome: Sendable, Equatable {
    case answered
    case silent(afterMs: Int)
    case failed(String)
  }

  let deadlineMs: Int
  let intervalSeconds: Double
  private let lock = NSLock()
  private var inFlight: Task<Outcome, Never>?
  private var latest: Task<Outcome, Never>?
  private var startedAt: Double?
  private var misses = 0

  init(deadlineMs: Int = BridgeProbe.defaultDeadlineMs, intervalSeconds: Double = BridgeProbe.defaultIntervalSeconds) {
    self.deadlineMs = deadlineMs
    self.intervalSeconds = intervalSeconds
  }

  /// The probe in flight, else the last one (tests wait on it).
  var current: Task<Outcome, Never>? { lock.withLock { inFlight ?? latest } }

  /// Probes in a row that did not answer.
  var silentInRow: Int { lock.withLock { misses } }

  /// The least time from the last probe to the next one right now.
  var intervalNow: Double { lock.withLock { interval(misses: misses) } }

  private func interval(misses: Int) -> Double {
    let scaled = intervalSeconds * pow(2, Double(max(0, misses - 1)))
    return min(scaled, max(intervalSeconds, Self.maxIntervalSeconds))
  }

  /// The probe in flight, or a new one; nil inside the back-off. `settled` runs once with the outcome before the task
  /// ends, so whoever awaits the task sees its effects.
  func start(
    now: Double, deadlineMs: Int? = nil, check: @escaping @Sendable () async throws -> Void,
    settled: @escaping @Sendable (Outcome, Int) -> Void
  ) -> Task<Outcome, Never>? {
    lock.withLock { () -> Task<Outcome, Never>? in
      if let inFlight { return inFlight }
      if let startedAt, now - startedAt < interval(misses: misses) { return nil }
      startedAt = now
      let deadlineMs = deadlineMs ?? self.deadlineMs
      let task = Task<Outcome, Never> { [weak self] in
        let started = ContinuousClock.now
        let outcome: Outcome
        do {
          try await Session.bounded(check, deadlineMs: deadlineMs)
          outcome = .answered
        } catch let stall as BridgeStalled {
          outcome = .silent(afterMs: stall.afterMs)
        } catch {
          outcome = .failed(WireError.from(error).message)
        }
        self?.finish(outcome)
        settled(outcome, Session.elapsedMs(since: started))
        return outcome
      }
      inFlight = task
      latest = task
      return task
    }
  }

  private func finish(_ outcome: Outcome) {
    lock.withLock {
      inFlight = nil
      misses = outcome == .answered ? 0 : misses + 1
    }
  }
}

/// Ends a guest that stalled after it had answered (`GuestRecycling`), so the next read starts on a fresh one instead
/// of whatever the stalled one is still doing. A cold guest is never recycled: it is slow, not stuck, and a recycle
/// would only make it cold again. At most `maxRecycles` per helper (a recycle that found no guest is not counted);
/// past that the bridge is left to the cooldown and the probe, and the reads stay on `ax` while it is silent.
final class BridgeReaper: @unchecked Sendable {
  static let defaultMaxRecycles = 3

  let maxRecycles: Int
  private let recycle: @Sendable () async -> Int
  private let lock = NSLock()
  private var spent = 0
  private var told = false
  private var inFlight: Task<Void, Never>?
  private var latest: Task<Void, Never>?

  /// `recycle` ends the guests and answers how many it ended.
  init(maxRecycles: Int = BridgeReaper.defaultMaxRecycles, recycle: @escaping @Sendable () async -> Int) {
    self.maxRecycles = maxRecycles
    self.recycle = recycle
  }

  /// Guests recycled after a stall so far.
  var recycles: Int { lock.withLock { spent } }
  var allowsRecycle: Bool { lock.withLock { spent < maxRecycles } }
  /// Every recycle this helper may do is spent: a stalled guest is left to the cooldown and the probe.
  var exhausted: Bool { !allowsRecycle }
  /// `health`'s `bridgeRecycles`: nil until a recycle ran.
  var healthJSON: JSON? {
    let (count, max) = lock.withLock { (spent, maxRecycles) }
    guard count > 0 else { return nil }
    return ["count": .int(count), "exhausted": .bool(count >= max)]
  }
  /// The recycle in flight, else the last one (tests wait on it).
  var current: Task<Void, Never>? { lock.withLock { inFlight ?? latest } }

  /// Starts a recycle in the background (joins one in flight); nil once the budget is spent, said once in the log.
  @discardableResult
  func recycleAfterStall(log: @escaping @Sendable (String) -> Void) -> Task<Void, Never>? {
    lock.withLock { () -> Task<Void, Never>? in
      if let inFlight { return inFlight }
      guard spent < maxRecycles else {
        if !told {
          told = true
          log("axbridge recycle budget spent (\(maxRecycles) this helper): a stalled guest is left to the cooldown and the probe")
        }
        return nil
      }
      let max = maxRecycles
      let task = Task<Void, Never> { [weak self] in
        let started = ContinuousClock.now
        let ended = await self?.recycle() ?? 0
        let count = self?.finish(ended: ended) ?? 0
        if ended > 0 {
          log("axbridge stalled after it had answered: recycled \(ended) guest(s) in \(Session.elapsedMs(since: started)) ms (\(count) of \(max) this helper); the next read is cold")
        } else {
          log("axbridge stalled after it had answered: no guest found to recycle")
        }
      }
      inFlight = task
      latest = task
      return task
    }
  }

  private func finish(ended: Int) -> Int {
    lock.withLock {
      inFlight = nil
      if ended > 0 { spent += 1 }
      return spent
    }
  }
}

/// What a session probes the bridge with (`BridgeProbe` + its liveness check); nil where nothing can be probed.
struct BridgeRecovery: Sendable {
  var probe: BridgeProbe
  var check: @Sendable () async throws -> Void
}

/// What one bridge fallback or stall looked like, for the client's run evidence (`fallback.stall` on a snapshot,
/// `detail.stall` on a failed read).
struct BridgeStallReport: Sendable, Equatable {
  enum Stage: String, Sendable {
    /// No bridge reader to ask (the guest never came up).
    case connect
    /// A bridge read was made and stalled past its deadline or failed.
    case read
    /// The read joined a background warm-up read that stalled, and was not asked again.
    case warmUp = "warm-up"
    /// The bridge was skipped: a stall within the cooldown.
    case cooldown
  }

  var stage: Stage
  /// How long the bridge read ran before it stalled or failed; nil when the bridge was not asked.
  var readMs: Int?
  /// The deadline that read had (the cold one while the guest is cold); nil when the bridge was not asked or has none.
  var deadlineMs: Int?
  /// How long the current AX guests have been up (since helper start or their last recycle / reap).
  var guestAgeMs: Int?
  /// The guest had not answered since it last went cold (helper start, recycle, launch): a first read.
  var cold: Bool
  /// What is left of the stall cooldown after this read; nil when none is armed.
  var cooldownRemainingMs: Int?
  /// Bridge reads and background probes that failed in a row since the bridge last answered, this one included.
  var probes: Int
  /// Stalled guests this helper recycled before this read (`BridgeReaper.recycles`); a recycle this stall starts is
  /// in the next report.
  var recycles = 0
  /// Every recycle this helper may do was spent before this read (`BridgeReaper.exhausted`).
  var recyclesExhausted = false

  var json: JSON {
    var fields: [String: JSON] = ["stage": .string(stage.rawValue), "cold": .bool(cold), "probes": .int(probes)]
    if let readMs { fields["readMs"] = .int(readMs) }
    if let deadlineMs { fields["deadlineMs"] = .int(deadlineMs) }
    if let guestAgeMs { fields["guestAgeMs"] = .int(guestAgeMs) }
    if let cooldownRemainingMs { fields["cooldownRemainingMs"] = .int(cooldownRemainingMs) }
    if recycles > 0 { fields["recycles"] = .int(recycles) }
    if recyclesExhausted { fields["recyclesExhausted"] = .bool(true) }
    return .object(fields)
  }
}

/// An `axbridge` read that did not answer within `BridgeDeadline.readMs`.
struct BridgeStalled: Error, LocalizedError, Sendable {
  var afterMs: Int
  /// Set by `Session.readAX` before the stall reaches the client.
  var report: BridgeStallReport?

  var errorDescription: String? {
    "the axbridge guest did not answer within \(afterMs) ms (stage: bridge read; the in-sim SimulatorFrameworkBridge guest is up but silent)"
  }
}

/// When the bridge last stalled, so the reads inside the cooldown skip it, how many bridge reads in a row failed, and
/// whether the last recovery probe was silent, which keeps the reads on `ax` until a probe or a read answers. A silent
/// probe does not restart the cooldown: the probe's own back-off (`BridgeProbe.intervalNow`) spaces the next try.
final class BridgeStallGate: @unchecked Sendable {
  private let lock = NSLock()
  private var stalledAt: Double?
  private var failures = 0
  private var probeSilent = false

  func recordStall(at now: Double) {
    lock.withLock { stalledAt = now }
  }

  /// A bridge read failed (a stall included); returns the failures in a row, this one included.
  @discardableResult
  func recordFailure() -> Int {
    lock.withLock {
      failures += 1
      return failures
    }
  }

  var failuresInARow: Int { lock.withLock { failures } }

  /// Milliseconds left of the cooldown, or nil when none is armed.
  func cooldownRemainingMs(now: Double, cooldownSeconds: Double) -> Int? {
    guard let stalledAt = lock.withLock({ stalledAt }), cooldownSeconds > 0 else { return nil }
    let left = cooldownSeconds - (now - stalledAt)
    return left > 0 ? Int((left * 1000).rounded()) : nil
  }

  /// A recovery probe did not answer: reads stay on `ax` until one does.
  func holdForProbe() {
    lock.withLock { probeSilent = true }
  }

  func recordSuccess() {
    lock.withLock {
      stalledAt = nil
      failures = 0
      probeSilent = false
    }
  }

  var lastStallAt: Double? { lock.withLock { stalledAt } }

  /// Why the bridge is skipped right now, or nil when it may be asked.
  func skipReason(now: Double, cooldownSeconds: Double) -> String? {
    guard cooldownSeconds > 0 else { return nil }
    let (stalledAt, held) = lock.withLock { (stalledAt, probeSilent) }
    if held { return "axbridge recovery probe did not answer; reading on ax until a probe answers" }
    guard let stalledAt else { return nil }
    let ago = now - stalledAt
    guard ago < cooldownSeconds else { return nil }
    return "axbridge stalled \(Int(ago.rounded())) s ago; reading on ax for up to \(Int(cooldownSeconds)) s after a stall"
  }
}

extension Session {
  /// One AX read on the requested reader (nil = `axbridge`, falling back to `ax`), pure over its readers so a
  /// scripted guest can test it. `bridge` / `host` are nil when that reader does not exist.
  ///
  /// - `ax` asked for: the host reader only.
  /// - bridge inside a stall cooldown (no explicit backend, a host reader exists): straight to `ax`.
  /// - a warm-up read in flight (`BridgeWarmth.warmUp`) is waited for first; one that stalled sends this read
  ///   (no explicit backend, a host reader exists) to `ax` without a second wait on the bridge.
  /// - otherwise each bridge read attempt is bounded by `policy.readMs` (`coldReadMs` while the guest is cold); a
  ///   not-responding app is recovered and read again (`readRecovering`); a bridge failure (a stall included) with no
  ///   explicit backend is read on `ax`. A cold guest's first stall does not arm the cooldown.
  /// - with a `recovery`, a read the cooldown or a stalled warm-up sends to `ax` starts a background `BridgeProbe`
  ///   and does not wait for it; a probe that answers ends the cooldown (and warms the guest), a silent one re-arms
  ///   it, so no caller pays the full read deadline while the guest stays silent. An explicit `axbridge` read inside
  ///   the cooldown waits for the probe only (its short deadline), then reads, or fails as a stall without a read.
  static func readAX<Value: Sendable>(
    requested: AXBackend?,
    bridge: (@Sendable () async throws -> Value)?,
    host: (@Sendable () async throws -> Value)?,
    recover: @escaping @Sendable (pid_t?) async -> Void,
    policy: BridgeDeadline,
    gate: BridgeStallGate,
    warmth: BridgeWarmth,
    health: BridgeHealth,
    recovery: BridgeRecovery? = nil,
    reaper: BridgeReaper? = nil,
    now: @escaping @Sendable () -> Double,
    log: @escaping @Sendable (String) -> Void,
    bridgeName: String,
    guestAgeSeconds: @Sendable () -> Double? = { nil }
  ) async throws -> AXOutcome<Value> {
    if requested == .ax {
      guard let host else {
        throw WireError(.axUnavailable, "the host accessibility (ax) reader could not be created")
      }
      return AXOutcome(value: try await host(), backend: .ax, fallback: nil)
    }

    let cold = warmth.isCold
    let recycled = (count: reaper?.recycles ?? 0, exhausted: reaper?.exhausted ?? false)
    func report(_ stage: BridgeStallReport.Stage, readMs: Int? = nil, deadlineMs: Int? = nil) -> BridgeStallReport {
      BridgeStallReport(
        stage: stage, readMs: readMs, deadlineMs: deadlineMs,
        guestAgeMs: guestAgeSeconds().map { Int(($0 * 1000).rounded()) }, cold: cold,
        cooldownRemainingMs: gate.cooldownRemainingMs(now: now(), cooldownSeconds: policy.cooldownSeconds),
        probes: gate.failuresInARow, recycles: recycled.count, recyclesExhausted: recycled.exhausted)
    }

    let reason: String
    let stall: BridgeStallReport
    let probe = { () -> Task<BridgeProbe.Outcome, Never>? in
      guard let recovery else { return nil }
      return startProbe(
        recovery, policy: policy, gate: gate, warmth: warmth, health: health, now: now, log: log)
    }
    if let bridge {
      let skip = gate.skipReason(now: now(), cooldownSeconds: policy.cooldownSeconds)
      if requested == .axbridge, skip != nil, recovery != nil {
        // an explicit read pays the probe's short deadline, never the full read's (nor a cold probe's), while the
        // guest is cooling down
        let waitMs = recovery?.probe.deadlineMs ?? 0
        // a warm guest's probe has that short deadline itself and counts its own outcome before it returns, so it is
        // awaited as is (a second timer at the same deadline would race it); only a cold probe's wait is cut short
        let probeIsShort = !warmth.isCold
        let outcome: BridgeProbe.Outcome?
        if let task = probe() {
          outcome = probeIsShort ? await task.value : try? await bounded({ await task.value }, deadlineMs: waitMs)
        } else {
          outcome = nil
        }
        guard outcome == .answered else {
          throw BridgeStalled(afterMs: waitMs, report: report(.cooldown, deadlineMs: waitMs))
        }
      }
      if requested == nil, host != nil, let skip {
        _ = probe()
        reason = skip
        stall = report(.cooldown)
      } else if case let .stalled(afterMs)? = await warmth.joinWarmUp(), requested == nil, host != nil {
        _ = probe()
        reason = "axbridge warm-up did not answer within \(afterMs) ms (cold guest)"
        stall = report(.warmUp, deadlineMs: afterMs)
      } else {
        let generation = warmth.generation
        let coldAtStart = warmth.isCold
        let deadlineMs = warmth.deadlineMs(policy)
        let started = ContinuousClock.now
        do {
          let value = try await readRecovering(
            read: { try await bounded(bridge, deadlineMs: deadlineMs) },
            recover: recover, log: log)
          warmth.noteSuccess(generation: generation)
          health.recordSuccess()
          gate.recordSuccess()
          return AXOutcome(value: value, backend: .axbridge, fallback: nil)
        } catch {
          let readMs = Session.elapsedMs(since: started)
          if let stall = error as? BridgeStalled {
            noteStall(
              stall, generation: generation, coldAtStart: coldAtStart, gate: gate, warmth: warmth, reaper: reaper,
              now: now, log: log)
          }
          if isBridgeFailure(error) {
            health.recordFailure(WireError.from(error).message)
            gate.recordFailure()
          }
          stall = report(.read, readMs: readMs, deadlineMs: deadlineMs)
          guard requested == nil, isBridgeFailure(error), host != nil else {
            if var stalled = error as? BridgeStalled {
              stalled.report = stall
              throw stalled
            }
            throw error
          }
          reason = WireError.from(error).message
        }
      }
    } else {
      guard requested == nil, host != nil else {
        throw WireError(.axUnavailable, "the axbridge reader is unavailable (bridge \(bridgeName))")
      }
      reason = "axbridge reader unavailable (bridge \(bridgeName))"
      stall = report(.connect)
    }
    log("axbridge -> ax fallback: \(reason)")
    do {
      let value = try await host!()
      return AXOutcome(value: value, backend: .ax, fallback: Fallback(reason: reason, stall: stall))
    } catch {
      throw AXReadersFailed(bridgeReason: reason, host: error, stall: stall)
    }
  }

  /// What a stalled bridge read leaves behind. A cold guest's first stall is exempt (asked again next read); any
  /// other arms the cooldown. A stall on a guest that had answered also means the guest is gone or going (idb ends the
  /// guest of a cancelled request, and the reaper ends one still stuck), so the guest is cold again, without a second
  /// exempt stall, and is recycled while the budget lasts.
  static func noteStall(
    _ stall: BridgeStalled, generation: Int, coldAtStart: Bool, gate: BridgeStallGate, warmth: BridgeWarmth,
    reaper: BridgeReaper?, now: @escaping @Sendable () -> Double, log: @escaping @Sendable (String) -> Void
  ) {
    if warmth.takeExemptStall(generation: generation) {
      log("axbridge: \(stall.localizedDescription) (cold guest: the bridge is asked again next read)")
      return
    }
    gate.recordStall(at: now())
    log("axbridge: \(stall.localizedDescription)")
    guard !coldAtStart, warmth.generation == generation else { return }
    warmth.markCold(exemptStall: false)
    reaper?.recycleAfterStall(log: log)
  }

  /// Starts (or joins) a recovery probe whose outcome updates the gate, the guest's warmth and health. A probe on a
  /// cold guest gets the cold deadline: it runs in the background, and a guest that is starting again cannot answer
  /// within the short one on a slow host.
  static func startProbe(
    _ recovery: BridgeRecovery, policy: BridgeDeadline, gate: BridgeStallGate, warmth: BridgeWarmth,
    health: BridgeHealth, now: @escaping @Sendable () -> Double, log: @escaping @Sendable (String) -> Void
  ) -> Task<BridgeProbe.Outcome, Never>? {
    let generation = warmth.generation
    let deadlineMs = warmth.isCold ? max(recovery.probe.deadlineMs, policy.coldDeadlineMs ?? 0) : nil
    return recovery.probe.start(now: now(), deadlineMs: deadlineMs, check: recovery.check) { outcome, elapsedMs in
      switch outcome {
      case .answered:
        warmth.noteSuccess(generation: generation)
        health.recordSuccess()
        gate.recordSuccess()
        log("axbridge probe answered in \(elapsedMs) ms; reads use axbridge again")
      case let .silent(afterMs):
        gate.holdForProbe()
        gate.recordFailure()
        // the cut-off probe took its guest down: the next probe (or read) starts a new one
        if warmth.generation == generation, !warmth.isCold { warmth.markCold(exemptStall: false) }
        log(
          "axbridge probe did not answer within \(afterMs) ms (\(recovery.probe.silentInRow) in a row); reads stay on ax, next probe in \(Int(recovery.probe.intervalNow)) s")
      case let .failed(message):
        gate.recordFailure()
        log("axbridge probe failed: \(message)")
      }
    }
  }

  /// `read`, failing with `BridgeStalled` after `deadlineMs` (nil = wait as long as it takes). The stalled read is
  /// cancelled and left to end in the background.
  static func bounded<Value: Sendable>(
    _ read: @escaping @Sendable () async throws -> Value, deadlineMs: Int?
  ) async throws -> Value {
    guard let deadlineMs else { return try await read() }
    return try await withTimeout(milliseconds: deadlineMs, error: { BridgeStalled(afterMs: deadlineMs) }, read)
  }
}
