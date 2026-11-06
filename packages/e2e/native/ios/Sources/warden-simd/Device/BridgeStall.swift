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

  /// The guest was replaced or the app relaunched: the next read is cold again, with a fresh exempt stall.
  func markCold() {
    lock.withLock {
      cold = true
      spell += 1
      exemptStallUsed = false
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

  /// The outcome of the warm-up in flight for the current spell, waited for; nil when none is running.
  func joinWarmUp() async -> WarmUp? {
    guard let task = lock.withLock({ inFlight?.spell == spell ? inFlight?.task : nil }) else { return nil }
    return await task.value
  }
}

/// An `axbridge` read that did not answer within `BridgeDeadline.readMs`.
struct BridgeStalled: Error, LocalizedError, Sendable {
  var afterMs: Int

  var errorDescription: String? {
    "the axbridge guest did not answer within \(afterMs) ms (stage: bridge read; the in-sim SimulatorFrameworkBridge guest is up but silent)"
  }
}

/// When the bridge last stalled, so the reads inside the cooldown skip it.
final class BridgeStallGate: @unchecked Sendable {
  private let lock = NSLock()
  private var stalledAt: Double?

  func recordStall(at now: Double) {
    lock.withLock { stalledAt = now }
  }

  func recordSuccess() {
    lock.withLock { stalledAt = nil }
  }

  /// Why the bridge is skipped right now, or nil when it may be asked.
  func skipReason(now: Double, cooldownSeconds: Double) -> String? {
    guard let stalledAt = lock.withLock({ stalledAt }), cooldownSeconds > 0 else { return nil }
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
  static func readAX<Value: Sendable>(
    requested: AXBackend?,
    bridge: (@Sendable () async throws -> Value)?,
    host: (@Sendable () async throws -> Value)?,
    recover: @escaping @Sendable (pid_t?) async -> Void,
    policy: BridgeDeadline,
    gate: BridgeStallGate,
    warmth: BridgeWarmth,
    health: BridgeHealth,
    now: @Sendable () -> Double,
    log: @escaping @Sendable (String) -> Void,
    bridgeName: String
  ) async throws -> AXOutcome<Value> {
    if requested == .ax {
      guard let host else {
        throw WireError(.axUnavailable, "the host accessibility (ax) reader could not be created")
      }
      return AXOutcome(value: try await host(), backend: .ax, fallback: nil)
    }

    let reason: String
    if let bridge {
      if requested == nil, host != nil,
        let skip = gate.skipReason(now: now(), cooldownSeconds: policy.cooldownSeconds)
      {
        reason = skip
      } else if case let .stalled(afterMs)? = await warmth.joinWarmUp(), requested == nil, host != nil {
        reason = "axbridge warm-up did not answer within \(afterMs) ms (cold guest)"
      } else {
        let generation = warmth.generation
        let deadlineMs = warmth.deadlineMs(policy)
        do {
          let value = try await readRecovering(
            read: { try await bounded(bridge, deadlineMs: deadlineMs) },
            recover: recover, log: log)
          warmth.noteSuccess(generation: generation)
          health.recordSuccess()
          gate.recordSuccess()
          return AXOutcome(value: value, backend: .axbridge, fallback: nil)
        } catch {
          if let stall = error as? BridgeStalled {
            if warmth.takeExemptStall(generation: generation) {
              log("axbridge: \(stall.localizedDescription) (cold guest: the bridge is asked again next read)")
            } else {
              gate.recordStall(at: now())
              log("axbridge: \(stall.localizedDescription)")
            }
          }
          if isBridgeFailure(error) { health.recordFailure(WireError.from(error).message) }
          guard requested == nil, isBridgeFailure(error), host != nil else { throw error }
          reason = WireError.from(error).message
        }
      }
    } else {
      guard requested == nil, host != nil else {
        throw WireError(.axUnavailable, "the axbridge reader is unavailable (bridge \(bridgeName))")
      }
      reason = "axbridge reader unavailable (bridge \(bridgeName))"
    }
    log("axbridge -> ax fallback: \(reason)")
    do {
      let value = try await host!()
      return AXOutcome(value: value, backend: .ax, fallback: Fallback(reason: reason))
    } catch {
      throw AXReadersFailed(bridgeReason: reason, host: error)
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
