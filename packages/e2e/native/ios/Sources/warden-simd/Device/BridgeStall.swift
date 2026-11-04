import Foundation

/// How long one `axbridge` read may take before it counts as a stalled guest, and how long the bridge is then skipped.
///
/// A guest that does not answer in time (seen on GitHub `macos-26` runners, 3 vCPU: a cold sim, or one booted beside a
/// local Xcode build, took 4-11 s for its first bridge read and every `snapshot` ended `E_TIMEOUT` at the client's 10 s) used to hang each read until the client's own timeout, with no fallback,
/// because only a bridge *error* fell back to the host `ax` reader. `readMs` turns the silence into a bridge failure
/// with time left for the `ax` read inside the client's 10 s; `cooldownSeconds` sends the reads that follow straight
/// to `ax`, so a dead guest costs one deadline, not one per read, and the bridge is probed again after it.
/// A healthy read takes 6-90 ms, ~200 ms first after a launch.
struct BridgeDeadline: Sendable, Equatable {
  /// `nil` = no deadline (`WARDEN_SIMD_BRIDGE_DEADLINE_MS=0`).
  var readMs: Int? = 4000
  var cooldownSeconds: Double = 20

  /// `WARDEN_SIMD_BRIDGE_DEADLINE_MS` (ms, `0` = off) and `WARDEN_SIMD_BRIDGE_COOLDOWN_S` (seconds, `0` = never
  /// skip); anything that is not a non-negative number keeps the default.
  static func configured(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> BridgeDeadline {
    var policy = BridgeDeadline()
    if let raw = environment["WARDEN_SIMD_BRIDGE_DEADLINE_MS"], let ms = Int(raw), ms >= 0 {
      policy.readMs = ms == 0 ? nil : ms
    }
    if let raw = environment["WARDEN_SIMD_BRIDGE_COOLDOWN_S"], let seconds = Double(raw), seconds >= 0 {
      policy.cooldownSeconds = seconds
    }
    return policy
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
  /// - otherwise each bridge read attempt is bounded by `policy.readMs`; a not-responding app is recovered and read
  ///   again (`readRecovering`); a bridge failure (a stall included) with no explicit backend is read on `ax`.
  static func readAX<Value: Sendable>(
    requested: AXBackend?,
    bridge: (@Sendable () async throws -> Value)?,
    host: (@Sendable () async throws -> Value)?,
    recover: @escaping @Sendable (pid_t?) async -> Void,
    policy: BridgeDeadline,
    gate: BridgeStallGate,
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
      } else {
        do {
          let value = try await readRecovering(
            read: { try await bounded(bridge, deadlineMs: policy.readMs) },
            recover: recover, log: log)
          health.recordSuccess()
          gate.recordSuccess()
          return AXOutcome(value: value, backend: .axbridge, fallback: nil)
        } catch {
          if let stall = error as? BridgeStalled {
            gate.recordStall(at: now())
            log("axbridge: \(stall.localizedDescription)")
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
    let value = try await host!()
    return AXOutcome(value: value, backend: .ax, fallback: Fallback(reason: reason))
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
