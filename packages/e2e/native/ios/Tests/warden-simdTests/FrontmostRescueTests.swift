import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import Foundation
import XCTest

@testable import warden_simd

private final class Log: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [String] = []
  private var queries: [AccessibilityElementQuery] = []
  func add(_ line: String) { lock.withLock { lines.append(line) } }
  func asked(_ query: AccessibilityElementQuery) { lock.withLock { queries.append(query) } }
  var logged: [String] { lock.withLock { lines } }
  var asked: [AccessibilityElementQuery] { lock.withLock { queries } }
}

private func ok(_ value: String, _ backend: AXBackend = .axbridge) -> AXOutcome<String> {
  AXOutcome(value: value, backend: backend, fallback: nil)
}

private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Double = 1000
  var now: Double { lock.withLock { value } }
  func advance(_ seconds: Double) { lock.withLock { value += seconds } }
}

/// On GitHub-hosted `macos-26` runners both AX readers resolve "frontmost" through the same in-sim
/// `AXPTranslator frontmostApplicationWithDisplayId:` lookup (the bridge guest's `windowServer` strategy and the host
/// translator's `frontmost` request). When that lookup is silent, the `ax` fallback fails the same way, so every
/// snapshot failed. A read whose frontmost could not be resolved is made again by pid (the app warden launched, the
/// stream's pid, SpringBoard), and later reads go straight to the pid for a cooldown.
final class FrontmostRescueTests: XCTestCase {
  private let policy = FrontmostPolicy(cooldownSeconds: 20)
  private let silent = AccessibilityError.serviceNotAnswering(
    .request(kind: "frontmost", timeout: 5), elapsed: 5.1, behindAbandoned: 0)

  private func rescue(
    gate: FrontmostLookupGate, clock: Clock = Clock(), log: Log,
    candidates: [PidTarget] = [PidTarget(pid: 42, source: .launched)],
    read: @escaping @Sendable (AccessibilityElementQuery) async throws -> AXOutcome<String>
  ) async throws -> TargetedOutcome<String> {
    try await Session.readTargeted(
      read: { query in
        log.asked(query)
        return try await read(query)
      },
      candidates: { candidates }, gate: gate, policy: policy, now: { clock.now },
      log: { log.add($0) })
  }

  func testAFrontmostReadThatWorksIsNotTargeted() async throws {
    let log = Log()
    let outcome = try await rescue(gate: FrontmostLookupGate(), log: log) { _ in ok("front") }
    XCTAssertEqual(outcome.outcome.value, "front")
    XCTAssertNil(outcome.target)
    XCTAssertEqual(log.asked, [.frontmost])
  }

  func testASilentFrontmostLookupIsReadAgainByTheLaunchedPid() async throws {
    let log = Log()
    let silent = self.silent
    let outcome = try await rescue(gate: FrontmostLookupGate(), log: log) { query in
      if query == .frontmost { throw silent }
      return ok("app")
    }
    XCTAssertEqual(outcome.outcome.value, "app")
    XCTAssertEqual(outcome.target, PidTarget(pid: 42, source: .launched))
    XCTAssertEqual(log.asked, [.frontmost, .application(pid: 42)])
    XCTAssertTrue(
      outcome.outcome.fallback?.reason.contains("frontmost") ?? false,
      "\(String(describing: outcome.outcome.fallback))")
    XCTAssertTrue(log.logged.contains { $0.contains("pid 42 (launched)") }, "\(log.logged)")
  }

  func testEveryFrontmostResolutionFailureCounts() {
    XCTAssertTrue(Session.isFrontmostUnresolved(silent))
    XCTAssertTrue(Session.isFrontmostUnresolved(AccessibilityError.noTranslationObject(.frontmost)))
    XCTAssertTrue(Session.isFrontmostUnresolved(AccessibilityError.noTranslationObject(nil)))
    XCTAssertTrue(
      Session.isFrontmostUnresolved(
        AXBridgeError.frontmostUnresolved(method: .windowServer, reason: "no application")))
    XCTAssertTrue(
      Session.isFrontmostUnresolved(
        AXReadersFailed(bridgeReason: "x", host: AccessibilityError.noTranslationObject(.frontmost))
      ))
    XCTAssertFalse(
      Session.isFrontmostUnresolved(
        AccessibilityError.serviceNotAnswering(
          .query(timeout: 10), elapsed: 10.8, behindAbandoned: 0)))
    XCTAssertFalse(
      Session.isFrontmostUnresolved(AccessibilityError.noTranslationObject(.application(pid: 3))))
    XCTAssertFalse(Session.isFrontmostUnresolved(AXBridgeError.applicationNotResponding(pid: 3)))
    XCTAssertFalse(Session.isFrontmostUnresolved(CancellationError()))
  }

  func testOtherFailuresAreNotRescued() async throws {
    let log = Log()
    do {
      _ = try await rescue(gate: FrontmostLookupGate(), log: log) { _ in
        throw AXBridgeError.applicationNotResponding(pid: 7)
      }
      XCTFail("expected a throw")
    } catch {
      XCTAssertEqual(log.asked, [.frontmost])
    }
  }

  func testReadsInsideTheCooldownGoStraightToThePid() async throws {
    let log = Log()
    let gate = FrontmostLookupGate()
    let clock = Clock()
    let silent = self.silent
    let read: @Sendable (AccessibilityElementQuery) async throws -> AXOutcome<String> = { query in
      if query == .frontmost { throw silent }
      return ok("app")
    }
    _ = try await rescue(gate: gate, clock: clock, log: log, read: read)
    clock.advance(5)
    let second = try await rescue(gate: gate, clock: clock, log: log, read: read)
    XCTAssertEqual(second.target?.pid, 42)
    XCTAssertEqual(log.asked, [.frontmost, .application(pid: 42), .application(pid: 42)])
    clock.advance(20)
    _ = try await rescue(gate: gate, clock: clock, log: log, read: read)
    XCTAssertEqual(
      log.asked.suffix(2), [.frontmost, .application(pid: 42)],
      "probes frontmost again after the cooldown")
  }

  func testTheCooldownDoublesWhileTheLookupKeepsFailingUpToFiveMinutes() {
    let gate = FrontmostLookupGate()
    gate.recordUnresolved(at: 1000)
    XCTAssertTrue(gate.skips(now: 1019, cooldownSeconds: 20))
    XCTAssertFalse(gate.skips(now: 1021, cooldownSeconds: 20))
    gate.recordUnresolved(at: 1021)
    XCTAssertTrue(gate.skips(now: 1060, cooldownSeconds: 20), "second failure: 40 s")
    XCTAssertFalse(gate.skips(now: 1062, cooldownSeconds: 20))
    for at in stride(from: 2000.0, to: 2010, by: 1) { gate.recordUnresolved(at: at) }
    XCTAssertTrue(gate.skips(now: 2009 + 299, cooldownSeconds: 20))
    XCTAssertFalse(gate.skips(now: 2009 + 301, cooldownSeconds: 20), "capped at 300 s")
    gate.recordResolved()
    gate.recordUnresolved(at: 3000)
    XCTAssertFalse(gate.skips(now: 3021, cooldownSeconds: 20), "an answer resets the backoff")
  }

  func testAFrontmostThatAnswersAgainEndsTheCooldown() async throws {
    let gate = FrontmostLookupGate()
    gate.recordUnresolved(at: 1000)
    gate.recordResolved()
    XCTAssertFalse(gate.skips(now: 1001, cooldownSeconds: 20))
  }

  func testCandidatesAreTriedInOrder() async throws {
    let log = Log()
    let silent = self.silent
    let outcome = try await rescue(
      gate: FrontmostLookupGate(), log: log,
      candidates: [PidTarget(pid: 42, source: .launched), PidTarget(pid: 9, source: .springboard)]
    ) { query in
      switch query {
      case .frontmost: throw silent
      case .application(pid: 42): throw AXBridgeError.applicationUnavailable(pid: 42)
      default: return ok("springboard", .ax)
      }
    }
    XCTAssertEqual(outcome.target, PidTarget(pid: 9, source: .springboard))
    XCTAssertEqual(outcome.outcome.backend, .ax)
  }

  func testNoCandidateLeavesARetryableErrorNamingBothReaders() async throws {
    let log = Log()
    let silent = self.silent
    do {
      _ = try await rescue(gate: FrontmostLookupGate(), log: log, candidates: []) { _ in
        throw AXReadersFailed(
          bridgeReason: "axbridge could not resolve the frontmost application", host: silent)
      }
      XCTFail("expected a throw")
    } catch {
      let wire = WireError.from(error)
      XCTAssertEqual(wire.code, .timeout)
      XCTAssertTrue(wire.retryable)
      XCTAssertEqual(wire.detail?["reason"]?.stringValue, "frontmost_unresolved")
      XCTAssertEqual(
        wire.detail?["bridgeError"]?.stringValue,
        "axbridge could not resolve the frontmost application")
      XCTAssertTrue(
        wire.detail?["axError"]?.stringValue?.contains("frontmost request") ?? false,
        "\(String(describing: wire.detail))")
    }
  }

  func testWhenBothReadersFailTheBridgeReasonTravelsWithTheHostError() async throws {
    let silent = self.silent
    do {
      _ = try await Session.readAX(
        requested: nil,
        bridge: {
          throw AXBridgeError.frontmostUnresolved(method: .windowServer, reason: "no application")
        },
        host: { () async throws -> String in throw silent }, recover: { _ in },
        policy: BridgeDeadline(readMs: 100, cooldownSeconds: 20), gate: BridgeStallGate(), warmth: .warmed(),
        health: BridgeHealth(),
        now: { 0 }, log: { _ in }, bridgeName: "available")
      XCTFail("expected a throw")
    } catch let both as AXReadersFailed {
      XCTAssertTrue(both.bridgeReason.contains("frontmost"), both.bridgeReason)
      XCTAssertTrue(Session.isFrontmostUnresolved(both))
    }
  }

  func testPolicyReadsTheEnvironment() {
    XCTAssertEqual(FrontmostPolicy.configured([:]).cooldownSeconds, 20)
    XCTAssertEqual(
      FrontmostPolicy.configured(["WARDEN_SIMD_FRONTMOST_COOLDOWN_S": "0"]).cooldownSeconds, 0)
    XCTAssertEqual(
      FrontmostPolicy.configured(["WARDEN_SIMD_FRONTMOST_COOLDOWN_S": "x"]).cooldownSeconds, 20)
    XCTAssertEqual(FrontmostPolicy.configured([:]).method, .windowServer)
    XCTAssertEqual(
      FrontmostPolicy.configured(["WARDEN_SIMD_FRONTMOST_METHOD": "runningBoard"]).method,
      .runningBoard)
    XCTAssertEqual(
      FrontmostPolicy.configured(["WARDEN_SIMD_FRONTMOST_METHOD": "center-point"]).method,
      .centerPoint)
    XCTAssertEqual(
      FrontmostPolicy.configured(["WARDEN_SIMD_FRONTMOST_METHOD": "nope"]).method, .windowServer)
  }
}

/// The host translator's errors were all `E_INTERNAL` and not retryable, so a locator gave up on the first one.
final class PidCandidateTests: XCTestCase {
  func testLaunchedThenStreamThenSpringBoardWithoutDeadOrRepeatedPids() {
    let alive: (pid_t) -> Bool = { $0 != 13 }
    XCTAssertEqual(
      Session.pidCandidates(launched: 42, stream: 42, springboard: 9, isAlive: alive),
      [PidTarget(pid: 42, source: .launched), PidTarget(pid: 9, source: .springboard)])
    XCTAssertEqual(
      Session.pidCandidates(launched: 13, stream: 7, springboard: nil, isAlive: alive),
      [PidTarget(pid: 7, source: .stream)])
    XCTAssertEqual(
      Session.pidCandidates(launched: nil, stream: nil, springboard: nil, isAlive: alive), [])
  }
}

final class AccessibilityErrorMappingTests: XCTestCase {
  func testASilentServiceIsARetryableTimeout() {
    let wire = WireError.from(
      AccessibilityError.serviceNotAnswering(
        .request(kind: "frontmost", timeout: 5), elapsed: 5.1, behindAbandoned: 2))
    XCTAssertEqual(wire.code, .timeout)
    XCTAssertTrue(wire.retryable)
    XCTAssertEqual(wire.detail?["stage"]?.stringValue, "ax")
    XCTAssertEqual(wire.detail?["request"]?.stringValue, "frontmost")
    XCTAssertEqual(wire.detail?["reason"]?.stringValue, "frontmost_unresolved")
  }

  func testNoFrontmostApplicationIsAxUnavailable() {
    let wire = WireError.from(AccessibilityError.noTranslationObject(.frontmost))
    XCTAssertEqual(wire.code, .axUnavailable)
    XCTAssertEqual(wire.detail?["reason"]?.stringValue, "frontmost_unresolved")
  }

  func testBothReadersFailingKeepsTheHostCodeAndTheBridgeReason() {
    let wire = WireError.from(
      AXReadersFailed(
        bridgeReason: "bridge said no", host: AXBridgeError.applicationNotResponding(pid: 4)))
    XCTAssertEqual(wire.code, .appNotResponding)
    XCTAssertEqual(wire.detail?["bridgeError"]?.stringValue, "bridge said no")
    XCTAssertEqual(wire.detail?["pid"]?.intValue, 4)
  }
}

final class HelperManifestTests: XCTestCase {
  func testParsesTheBuildManifest() {
    let data = Data(
      #"{"version":"0.1.0","idb":"v1.7.7","xcode":"27.1 (27A9275)","builtAt":"2026-11-05T00:00:00Z"}"#
        .utf8)
    XCTAssertEqual(HelperManifest.parse(data)?["xcode"]?.stringValue, "27.1 (27A9275)")
    XCTAssertNil(HelperManifest.parse(Data("nope".utf8)))
  }
}
