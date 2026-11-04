import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import Foundation
import XCTest

@testable import warden_simd

private final class Calls: @unchecked Sendable {
  private let lock = NSLock()
  private var counts: [String: Int] = [:]
  private var lines: [String] = []
  func bump(_ name: String) { lock.withLock { counts[name, default: 0] += 1 } }
  func count(_ name: String) -> Int { lock.withLock { counts[name] ?? 0 } }
  func add(_ line: String) { lock.withLock { lines.append(line) } }
  var logged: [String] { lock.withLock { lines } }
}

private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Double = 1000
  var now: Double { lock.withLock { value } }
  func advance(_ seconds: Double) { lock.withLock { value += seconds } }
}

/// An in-sim bridge guest that never answers (seen on a slow GitHub `macos-26` runner, every
/// `snapshot` `E_TIMEOUT` after the client's 10 s) must not take the read down with it: the bridge read gets its own
/// deadline, a stall is a bridge failure that falls back to the host `ax` reader, and the bridge is skipped for a
/// cooldown so every later read does not pay the deadline again.
final class BridgeStallTests: XCTestCase {
  private let policy = BridgeDeadline(readMs: 100, cooldownSeconds: 20)

  private func hang(_ calls: Calls) -> @Sendable () async throws -> String {
    {
      calls.bump("bridge")
      try await Task.sleep(for: .seconds(30))
      return "late"
    }
  }

  private func answer(_ name: String, _ calls: Calls) -> @Sendable () async throws -> String {
    {
      calls.bump(name)
      return name
    }
  }

  private func read(
    requested: AXBackend? = nil,
    bridge: (@Sendable () async throws -> String)?,
    host: (@Sendable () async throws -> String)?,
    gate: BridgeStallGate,
    health: BridgeHealth = BridgeHealth(),
    clock: Clock = Clock(),
    calls: Calls
  ) async throws -> AXOutcome<String> {
    try await Session.readAX(
      requested: requested, bridge: bridge, host: host, recover: { _ in calls.bump("recover") }, policy: policy,
      gate: gate, health: health, now: { clock.now }, log: { calls.add($0) }, bridgeName: "available")
  }

  func testAHungBridgeReadFallsBackToAxWithinTheDeadline() async throws {
    let calls = Calls()
    let started = ContinuousClock.now
    let outcome = try await read(bridge: hang(calls), host: answer("ax", calls), gate: BridgeStallGate(), calls: calls)
    let elapsed = ContinuousClock.now - started
    XCTAssertEqual(outcome.value, "ax")
    XCTAssertEqual(outcome.backend, .ax)
    XCTAssertTrue(outcome.fallback?.reason.contains("did not answer within 100 ms") ?? false, "\(outcome.fallback?.reason ?? "nil")")
    XCTAssertLessThan(elapsed, .seconds(2))
    XCTAssertTrue(calls.logged.contains { $0.contains("axbridge -> ax fallback") })
  }

  func testAStallMarksTheBridgeDegradedForHealth() async throws {
    let calls = Calls()
    let health = BridgeHealth()
    _ = try await read(bridge: hang(calls), host: answer("ax", calls), gate: BridgeStallGate(), health: health, calls: calls)
    XCTAssertTrue(health.lastFailure?.message.contains("did not answer") ?? false)
  }

  func testAfterAStallTheBridgeIsSkippedUntilTheCooldownEnds() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let clock = Clock()
    _ = try await read(bridge: hang(calls), host: answer("ax", calls), gate: gate, clock: clock, calls: calls)
    XCTAssertEqual(calls.count("bridge"), 1)

    clock.advance(5)
    let skipped = try await read(bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock, calls: calls)
    XCTAssertEqual(skipped.backend, .ax)
    XCTAssertEqual(calls.count("bridge"), 1, "the bridge is not asked inside the cooldown")
    XCTAssertTrue(skipped.fallback?.reason.contains("stalled") ?? false)

    clock.advance(20)
    let probed = try await read(bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock, calls: calls)
    XCTAssertEqual(probed.backend, .axbridge)
    XCTAssertNil(probed.fallback)
    XCTAssertEqual(calls.count("bridge"), 2)

    let next = try await read(bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock, calls: calls)
    XCTAssertEqual(next.backend, .axbridge, "a good bridge read ends the stall")
  }

  func testTheCooldownIsIgnoredWithoutAHostReader() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    gate.recordStall(at: Clock().now)
    let outcome = try await read(bridge: answer("bridge", calls), host: nil, gate: gate, calls: calls)
    XCTAssertEqual(outcome.backend, .axbridge)
  }

  func testAnExplicitBridgeReadThatStallsIsATimeoutNamingTheStage() async throws {
    let calls = Calls()
    do {
      _ = try await read(requested: .axbridge, bridge: hang(calls), host: answer("ax", calls), gate: BridgeStallGate(), calls: calls)
      XCTFail("expected a timeout")
    } catch {
      let wire = WireError.from(error)
      XCTAssertEqual(wire.code, .timeout)
      XCTAssertTrue(wire.message.contains("axbridge"), wire.message)
      XCTAssertTrue(wire.message.contains("100 ms"), wire.message)
    }
    XCTAssertEqual(calls.count("ax"), 0)
  }

  func testAGuestThatIdbReportsAsNotAnsweringFallsBackToo() async throws {
    let calls = Calls()
    XCTAssertTrue(Session.isBridgeFailure(AXBridgeError.guestNotAnswering(after: 5)))
    XCTAssertTrue(Session.isBridgeFailure(BridgeStalled(afterMs: 100)))
    let outcome = try await read(
      bridge: { throw AXBridgeError.guestNotAnswering(after: 5) }, host: answer("ax", calls), gate: BridgeStallGate(),
      calls: calls)
    XCTAssertEqual(outcome.backend, .ax)
  }

  func testAFastBridgeReadNeverTouchesTheHostReader() async throws {
    let calls = Calls()
    let outcome = try await read(bridge: answer("bridge", calls), host: answer("ax", calls), gate: BridgeStallGate(), calls: calls)
    XCTAssertEqual(outcome.backend, .axbridge)
    XCTAssertEqual(calls.count("ax"), 0)
  }

  func testNotRespondingStillRecoversBeforeFallingBack() async throws {
    let calls = Calls()
    let flaky: @Sendable () async throws -> String = {
      calls.bump("bridge")
      if calls.count("bridge") == 1 { throw AXBridgeError.applicationNotResponding(pid: 7) }
      return "bridge"
    }
    let outcome = try await read(bridge: flaky, host: answer("ax", calls), gate: BridgeStallGate(), calls: calls)
    XCTAssertEqual(outcome.backend, .axbridge)
    XCTAssertEqual(calls.count("recover"), 1)
  }

  func testDeadlineAndCooldownAreConfigurable() {
    XCTAssertEqual(BridgeDeadline.configured([:]), BridgeDeadline())
    XCTAssertEqual(BridgeDeadline().readMs, 4000)
    XCTAssertEqual(BridgeDeadline().cooldownSeconds, 20)
    XCTAssertEqual(BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_DEADLINE_MS": "2500"]).readMs, 2500)
    XCTAssertNil(BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_DEADLINE_MS": "0"]).readMs, "0 turns the deadline off")
    XCTAssertEqual(BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_DEADLINE_MS": "soon"]).readMs, 4000)
    XCTAssertEqual(BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_COOLDOWN_S": "3"]).cooldownSeconds, 3)
    XCTAssertEqual(BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_COOLDOWN_S": "-1"]).cooldownSeconds, 20)
  }

  func testNoDeadlineWaitsForTheBridge() async throws {
    let calls = Calls()
    let slow: @Sendable () async throws -> String = {
      try await Task.sleep(for: .milliseconds(150))
      return "bridge"
    }
    let outcome = try await Session.readAX(
      requested: nil, bridge: slow, host: answer("ax", calls), recover: { _ in },
      policy: BridgeDeadline(readMs: nil, cooldownSeconds: 20), gate: BridgeStallGate(), health: BridgeHealth(),
      now: { 0 }, log: { _ in }, bridgeName: "available")
    XCTAssertEqual(outcome.backend, .axbridge)
  }
}
