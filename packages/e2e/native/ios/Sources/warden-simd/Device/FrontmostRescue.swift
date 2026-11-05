import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import Foundation

/// How the bridge guest finds the frontmost app, and how long reads skip the frontmost lookup after it failed.
///
/// Both readers resolve `frontmost` through the same in-sim `AXPTranslator frontmostApplicationWithDisplayId:` call:
/// the guest's `windowServer` strategy and the host translator's `frontmost` request. On GitHub-hosted `macos-26`
/// runners that call answers nothing (`window-server frontmost returned no application`, then `did not answer a
/// frontmost request within 5.0s` / `named no frontmost application` on the host), so the `ax` fallback failed the
/// same way and every snapshot failed while the app drew fine. A pid-addressed read never asks for the frontmost app.
struct FrontmostPolicy: Sendable, Equatable {
  /// Reads skip the frontmost lookup this long after it failed (`0` = always try it first).
  var cooldownSeconds: Double = 20
  /// The bridge guest's frontmost strategy (`WARDEN_SIMD_FRONTMOST_METHOD`: `window-server` | `running-board` |
  /// `center-point`, camelCase accepted).
  var method: AXBridgeFrontmostMethod = .windowServer

  /// `runningBoard`, `running-board` and `runningboard` all name the same strategy.
  static func method(named name: String) -> AXBridgeFrontmostMethod? {
    let key = name.lowercased().replacingOccurrences(of: "-", with: "").replacingOccurrences(
      of: "_", with: "")
    return AXBridgeFrontmostMethod.allCases.first {
      $0.rawValue.lowercased().replacingOccurrences(of: "-", with: "") == key
    }
  }

  static func configured(_ environment: [String: String] = ProcessInfo.processInfo.environment)
    -> FrontmostPolicy
  {
    var policy = FrontmostPolicy()
    if let raw = environment["WARDEN_SIMD_FRONTMOST_COOLDOWN_S"], let seconds = Double(raw),
      seconds >= 0
    {
      policy.cooldownSeconds = seconds
    }
    if let raw = environment["WARDEN_SIMD_FRONTMOST_METHOD"], let method = method(named: raw) {
      policy.method = method
    }
    return policy
  }
}

/// Where the pid of a pid-addressed read came from.
enum PidSource: String, Sendable {
  /// The app this helper last launched, still running.
  case launched
  /// The process the quiescence stream last reported.
  case stream
  /// SpringBoard: the home screen and system prompts, when nothing else is known (e.g. before the first launch).
  case springboard
}

struct PidTarget: Sendable, Equatable {
  var pid: pid_t
  var source: PidSource
}

struct TargetedOutcome<Value: Sendable>: Sendable {
  var outcome: AXOutcome<Value>
  /// Set when the read was made by pid because the frontmost lookup failed.
  var target: PidTarget?
}

/// When the frontmost lookup last failed, so the reads inside the cooldown go straight to a pid.
final class FrontmostLookupGate: @unchecked Sendable {
  private let lock = NSLock()
  private var unresolvedAt: Double?

  func recordUnresolved(at now: Double) { lock.withLock { unresolvedAt = now } }
  func recordResolved() { lock.withLock { unresolvedAt = nil } }

  func skips(now: Double, cooldownSeconds: Double) -> Bool {
    guard cooldownSeconds > 0, let at = lock.withLock({ unresolvedAt }) else { return false }
    return now - at < cooldownSeconds
  }

  var lastUnresolvedAt: Double? { lock.withLock { unresolvedAt } }
}

/// Both readers failed one read: the host error, with what the bridge said before the fallback.
struct AXReadersFailed: Error, LocalizedError, Sendable {
  var bridgeReason: String
  var host: any Error

  var errorDescription: String? {
    "\(host.localizedDescription) (axbridge before it: \(bridgeReason))"
  }
}

extension Session {
  /// The read failed because the frontmost app could not be resolved, not because the app or the guest is gone.
  static func isFrontmostUnresolved(_ error: any Error) -> Bool {
    if let both = error as? AXReadersFailed { return isFrontmostUnresolved(both.host) }
    if let error = error as? AXBridgeError, case .frontmostUnresolved = error { return true }
    if let error = error as? AccessibilityError {
      switch error {
      case .serviceNotAnswering(.request(let kind, _), _, _): return kind == "frontmost"
      case .noTranslationObject(let query): return query == nil || query == .frontmost
      default: return false
      }
    }
    return false
  }

  /// One frontmost read through `read`; when its frontmost app could not be resolved, the same read by pid for each of
  /// `candidates` in order. Pure over its closures so a scripted sequence can test it.
  static func readTargeted<Value: Sendable>(
    read: @escaping @Sendable (AccessibilityElementQuery) async throws -> AXOutcome<Value>,
    candidates: @Sendable () async -> [PidTarget],
    gate: FrontmostLookupGate,
    policy: FrontmostPolicy,
    now: @Sendable () -> Double,
    log: @Sendable (String) -> Void
  ) async throws -> TargetedOutcome<Value> {
    var reason: String
    var failure: (any Error)?
    if gate.skips(now: now(), cooldownSeconds: policy.cooldownSeconds) {
      reason = "the frontmost lookup failed under \(Int(policy.cooldownSeconds)) s ago"
    } else {
      do {
        let outcome = try await read(.frontmost)
        gate.recordResolved()
        return TargetedOutcome(outcome: outcome, target: nil)
      } catch {
        guard isFrontmostUnresolved(error) else { throw error }
        gate.recordUnresolved(at: now())
        failure = error
        reason = WireError.from(error).message
      }
    }
    for candidate in await candidates() {
      do {
        var outcome = try await read(.application(pid: candidate.pid))
        log(
          "frontmost unresolved (\(reason)); read pid \(candidate.pid) (\(candidate.source.rawValue))"
        )
        let why =
          "frontmost unresolved: \(reason); read pid \(candidate.pid) (\(candidate.source.rawValue))"
        outcome.fallback = Fallback(reason: outcome.fallback.map { "\($0.reason); \(why)" } ?? why)
        return TargetedOutcome(outcome: outcome, target: candidate)
      } catch {
        log(
          "pid \(candidate.pid) (\(candidate.source.rawValue)) read failed: \(WireError.from(error).message)"
        )
        failure = failure ?? error
      }
    }
    if let failure { throw failure }
    throw WireError(
      .axUnavailable, "the frontmost app could not be resolved and no app pid is known (\(reason))",
      detail: ["reason": "frontmost_unresolved"])
  }

  /// The pids to read when the frontmost lookup fails: the app this helper launched, the stream's pid, SpringBoard.
  /// Dead and repeated pids are left out.
  static func pidCandidates(
    launched: pid_t?, stream: pid_t?, springboard: pid_t?, isAlive: (pid_t) -> Bool
  ) -> [PidTarget] {
    var seen = Set<pid_t>()
    var targets: [PidTarget] = []
    for (pid, source) in [
      (launched, PidSource.launched), (stream, .stream), (springboard, .springboard),
    ] {
      guard let pid, pid > 0, isAlive(pid), seen.insert(pid).inserted else { continue }
      targets.append(PidTarget(pid: pid, source: source))
    }
    return targets
  }

  /// `pidCandidates` for this simulator. SpringBoard is looked up (one launchd call) only when nothing else is known.
  func frontmostCandidates() async -> [PidTarget] {
    let launched = bundlePids.lastLaunched
    let stream = await existingQuiescenceMonitor()?.currentFrontmostPid()
    var targets = Session.pidCandidates(
      launched: launched, stream: stream, springboard: nil, isAlive: Session.processExists)
    if targets.isEmpty {
      let springboard: pid_t? = try? await simulator.application.processID(
        forBundleID: "com.apple.springboard")
      targets = Session.pidCandidates(
        launched: nil, stream: nil, springboard: springboard, isAlive: Session.processExists)
    }
    return targets
  }

  /// `withAX` for a frontmost read, made by pid when the frontmost app cannot be resolved (`readTargeted`).
  func withFrontmostAX<Value: Sendable>(
    backend requested: AXBackend?, op: String,
    _ body: @escaping @Sendable (any UIAutomation, AccessibilityElementQuery) async throws -> Value
  ) async throws -> TargetedOutcome<Value> {
    try await Session.readTargeted(
      read: { query in
        try await self.withAX(backend: requested, op: op) { reader in try await body(reader, query)
        }
      },
      candidates: { await self.frontmostCandidates() }, gate: frontmostGate,
      policy: frontmostPolicy,
      now: { ProcessInfo.processInfo.systemUptime }, log: { OpLog.shared.log(.warn, $0, op: op) })
  }
}
