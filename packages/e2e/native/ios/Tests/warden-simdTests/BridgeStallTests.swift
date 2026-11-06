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
    warmth: BridgeWarmth = .warmed(),
    policy: BridgeDeadline? = nil,
    health: BridgeHealth = BridgeHealth(),
    clock: Clock = Clock(),
    recovery: BridgeRecovery? = nil,
    calls: Calls
  ) async throws -> AXOutcome<String> {
    try await Session.readAX(
      requested: requested, bridge: bridge, host: host, recover: { _ in calls.bump("recover") },
      policy: policy ?? self.policy, gate: gate, warmth: warmth, health: health, recovery: recovery,
      now: { clock.now }, log: { calls.add($0) }, bridgeName: "available")
  }

  /// A probe whose liveness check is `check`, counted as `probe` calls.
  private func recovery(
    _ calls: Calls, deadlineMs: Int = 100, check: @escaping @Sendable () async throws -> Void
  ) -> BridgeRecovery {
    BridgeRecovery(
      probe: BridgeProbe(deadlineMs: deadlineMs, intervalSeconds: 5),
      check: {
        calls.bump("probe")
        try await check()
      })
  }

  private func slow(_ ms: Int, _ calls: Calls) -> @Sendable () async throws -> String {
    {
      calls.bump("bridge")
      try await Task.sleep(for: .milliseconds(ms))
      return "bridge"
    }
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
      policy: BridgeDeadline(readMs: nil, cooldownSeconds: 20), gate: BridgeStallGate(), warmth: BridgeWarmth(),
      health: BridgeHealth(), recovery: nil, now: { 0 }, log: { _ in }, bridgeName: "available")
    XCTAssertEqual(outcome.backend, .axbridge)
  }

  // MARK: cold first read

  private let coldPolicy = BridgeDeadline(readMs: 100, coldReadMs: 600, cooldownSeconds: 20)

  func testTheFirstReadOfAColdGuestGetsTheColdDeadline() async throws {
    let calls = Calls()
    let warmth = BridgeWarmth()
    XCTAssertTrue(warmth.isCold, "a new guest is cold")
    let outcome = try await read(
      bridge: slow(250, calls), host: answer("ax", calls), gate: BridgeStallGate(), warmth: warmth,
      policy: coldPolicy, calls: calls)
    XCTAssertEqual(outcome.backend, .axbridge, "250 ms is past the warm deadline but inside the cold one")
    XCTAssertNil(outcome.fallback)
    XCTAssertFalse(warmth.isCold, "a good read warms the guest")
  }

  func testAWarmedGuestIsBackOnTheNormalDeadline() async throws {
    let calls = Calls()
    let warmth = BridgeWarmth()
    _ = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: BridgeStallGate(), warmth: warmth,
      policy: coldPolicy, calls: calls)
    let outcome = try await read(
      bridge: slow(250, calls), host: answer("ax", calls), gate: BridgeStallGate(), warmth: warmth,
      policy: coldPolicy, calls: calls)
    XCTAssertEqual(outcome.backend, .ax)
    XCTAssertTrue(outcome.fallback?.reason.contains("100 ms") ?? false, "\(outcome.fallback?.reason ?? "nil")")
  }

  func testAColdStallFallsBackWithoutArmingTheCooldown() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let warmth = BridgeWarmth()
    let health = BridgeHealth()
    let clock = Clock()
    let outcome = try await read(
      bridge: hang(calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy,
      health: health, clock: clock, calls: calls)
    XCTAssertEqual(outcome.backend, .ax)
    XCTAssertTrue(outcome.fallback?.reason.contains("600 ms") ?? false, "\(outcome.fallback?.reason ?? "nil")")
    XCTAssertNil(gate.skipReason(now: clock.now, cooldownSeconds: 20), "a cold stall does not arm the cooldown")
    XCTAssertNotNil(health.lastFailure, "health still says the bridge is behind")
    XCTAssertTrue(warmth.isCold, "a stall does not warm the guest")

    let next = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy,
      clock: clock, calls: calls)
    XCTAssertEqual(next.backend, .axbridge, "the next read asks the bridge again")
  }

  func testASecondColdStallOnTheSameGuestArmsTheCooldown() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let warmth = BridgeWarmth()
    let clock = Clock()
    _ = try await read(
      bridge: hang(calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy, clock: clock,
      calls: calls)
    _ = try await read(
      bridge: hang(calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy, clock: clock,
      calls: calls)
    XCTAssertNotNil(gate.skipReason(now: clock.now, cooldownSeconds: 20), "a guest that never answers is skipped")
  }

  func testAGuestRecycleOrRelaunchMakesItColdAgain() async throws {
    let calls = Calls()
    let warmth = BridgeWarmth()
    _ = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: BridgeStallGate(), warmth: warmth,
      policy: coldPolicy, calls: calls)
    XCTAssertFalse(warmth.isCold)
    warmth.markCold()
    XCTAssertTrue(warmth.isCold)
    let outcome = try await read(
      bridge: slow(250, calls), host: answer("ax", calls), gate: BridgeStallGate(), warmth: warmth,
      policy: coldPolicy, calls: calls)
    XCTAssertEqual(outcome.backend, .axbridge, "the cold deadline applies again")
  }

  func testAReadThatStartedBeforeTheGuestWentColdDoesNotWarmTheNewOne() {
    let warmth = BridgeWarmth()
    let generation = warmth.generation
    warmth.markCold()
    warmth.noteSuccess(generation: generation)
    XCTAssertTrue(warmth.isCold)
    warmth.noteSuccess(generation: warmth.generation)
    XCTAssertFalse(warmth.isCold)
  }

  func testAColdStallAfterRecycleIsExemptAgain() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let warmth = BridgeWarmth()
    let clock = Clock()
    _ = try await read(
      bridge: hang(calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy, clock: clock,
      calls: calls)
    warmth.markCold()
    _ = try await read(
      bridge: hang(calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy, clock: clock,
      calls: calls)
    XCTAssertNil(gate.skipReason(now: clock.now, cooldownSeconds: 20), "a new guest gets its own exempt stall")
  }

  func testAlertReadsUseTheColdDeadlineToo() {
    let warmth = BridgeWarmth()
    XCTAssertEqual(warmth.deadlineMs(coldPolicy), 600)
    warmth.noteSuccess(generation: warmth.generation)
    XCTAssertEqual(warmth.deadlineMs(coldPolicy), 100)
    XCTAssertNil(BridgeWarmth().deadlineMs(BridgeDeadline(readMs: nil, cooldownSeconds: 20)), "0 turns both off")
  }

  func testTheColdDeadlineIsConfigurable() {
    XCTAssertEqual(BridgeDeadline().coldReadMs, BridgeDeadline.defaultColdReadMs)
    XCTAssertEqual(BridgeDeadline.defaultColdReadMs, 12_000)
    XCTAssertEqual(BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_COLD_DEADLINE_MS": "15000"]).coldReadMs, 15_000)
    XCTAssertEqual(BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_COLD_DEADLINE_MS": "x"]).coldReadMs, 12_000)
    XCTAssertEqual(
      BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_COLD_DEADLINE_MS": "1000"]).coldReadMs, 4000,
      "never shorter than the warm deadline")
    XCTAssertNil(BridgeDeadline.configured(["WARDEN_SIMD_BRIDGE_DEADLINE_MS": "0"]).coldReadMs, "0 turns both off")
  }

  // MARK: warm-up

  func testWarmUpIsSingleFlightAndWarmsTheGuest() async {
    let calls = Calls()
    let warmth = BridgeWarmth()
    let first = warmth.warmUp(deadlineMs: 1000, log: { calls.add($0) }) {
      calls.bump("warm")
      try await Task.sleep(for: .milliseconds(100))
    }
    let second = warmth.warmUp(deadlineMs: 1000, log: { calls.add($0) }) { calls.bump("warm") }
    let a = await first?.value
    let b = await second?.value
    XCTAssertEqual(a, .warmed)
    XCTAssertEqual(b, .warmed)
    XCTAssertEqual(calls.count("warm"), 1, "the second warm-up joins the first")
    XCTAssertFalse(warmth.isCold)
    XCTAssertNil(
      warmth.warmUp(deadlineMs: 1000, log: { _ in }) { calls.bump("warm") }, "a warm guest needs no warm-up")
  }

  func testAUserReadJoinsTheInFlightWarmUp() async throws {
    let calls = Calls()
    let warmth = BridgeWarmth()
    _ = warmth.warmUp(deadlineMs: 1000, log: { _ in }) {
      calls.bump("warm")
      try await Task.sleep(for: .milliseconds(150))
      calls.add("warm done")
    }
    let user: @Sendable () async throws -> String = {
      calls.add("user read")
      return "bridge"
    }
    let outcome = try await read(
      bridge: user, host: answer("ax", calls), gate: BridgeStallGate(), warmth: warmth, policy: coldPolicy,
      calls: calls)
    XCTAssertEqual(outcome.backend, .axbridge)
    XCTAssertEqual(calls.count("warm"), 1)
    XCTAssertEqual(calls.logged.filter { $0 == "warm done" || $0 == "user read" }, ["warm done", "user read"])
  }

  func testAUserReadThatJoinedAStalledWarmUpGoesToAxWithoutArmingTheCooldown() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let warmth = BridgeWarmth()
    let clock = Clock()
    _ = warmth.warmUp(deadlineMs: 100, log: { _ in }) { try await Task.sleep(for: .seconds(30)) }
    let outcome = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy,
      clock: clock, calls: calls)
    XCTAssertEqual(outcome.backend, .ax)
    XCTAssertEqual(calls.count("bridge"), 0, "no second wait on a guest that just stalled")
    XCTAssertTrue(outcome.fallback?.reason.contains("warm-up") ?? false, "\(outcome.fallback?.reason ?? "nil")")
    XCTAssertNil(gate.skipReason(now: clock.now, cooldownSeconds: 20))
    XCTAssertTrue(warmth.isCold)
  }

  func testAnExplicitAxReadNeverWaitsForTheWarmUp() async throws {
    let calls = Calls()
    let warmth = BridgeWarmth()
    _ = warmth.warmUp(deadlineMs: 5000, log: { _ in }) { try await Task.sleep(for: .seconds(30)) }
    let started = ContinuousClock.now
    let outcome = try await read(
      requested: .ax, bridge: answer("bridge", calls), host: answer("ax", calls), gate: BridgeStallGate(),
      warmth: warmth, policy: coldPolicy, calls: calls)
    XCTAssertEqual(outcome.backend, .ax)
    XCTAssertLessThan(ContinuousClock.now - started, .seconds(1))
  }

  // MARK: detached recovery probe

  func testTheProbeHasItsOwnShortDeadlineAndBackOff() {
    XCTAssertEqual(BridgeProbe.defaultDeadlineMs, 1500)
    XCTAssertLessThan(BridgeProbe.defaultDeadlineMs, BridgeDeadline().readMs ?? 0, "shorter than a user read")
    XCTAssertGreaterThanOrEqual(BridgeProbe.defaultIntervalSeconds, 5)
  }

  func testAReadInTheCooldownAnswersOnAxAtOnceAndProbesInTheBackground() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let clock = Clock()
    gate.recordStall(at: clock.now)
    let recovery = recovery(calls) { try await Task.sleep(for: .milliseconds(300)) }
    let started = ContinuousClock.now
    let outcome = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock, recovery: recovery,
      calls: calls)
    XCTAssertEqual(outcome.backend, .ax)
    XCTAssertLessThan(ContinuousClock.now - started, .milliseconds(250), "the caller never waits for the probe")
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(calls.count("probe"), 1)
    XCTAssertEqual(calls.count("bridge"), 0, "the probe is not a full tree read")
  }

  func testAProbeThatAnswersEndsTheCooldownSoTheNextReadUsesTheBridge() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let health = BridgeHealth()
    let clock = Clock()
    gate.recordStall(at: clock.now)
    health.recordFailure("stalled")
    let recovery = recovery(calls) {}
    _ = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, health: health, clock: clock,
      recovery: recovery, calls: calls)
    let probed = await recovery.probe.current?.value
    XCTAssertEqual(probed, .answered)
    XCTAssertNil(gate.skipReason(now: clock.now, cooldownSeconds: 20))
    XCTAssertNil(health.lastFailure)
    let next = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock, recovery: recovery,
      calls: calls)
    XCTAssertEqual(next.backend, .axbridge)
    XCTAssertNil(next.fallback)
  }

  func testProbesNeverStackAndWaitOutTheBackOff() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let clock = Clock()
    gate.recordStall(at: clock.now)
    let recovery = recovery(calls, deadlineMs: 100) { try await Task.sleep(for: .seconds(30)) }
    for _ in 0..<3 {
      _ = try await read(
        bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock, recovery: recovery,
        calls: calls)
    }
    _ = await recovery.probe.current?.value
    XCTAssertEqual(calls.count("probe"), 1, "reads during a probe join it")
    let first = await recovery.probe.current?.value
    XCTAssertEqual(first, .silent(afterMs: 100))

    clock.advance(2)
    _ = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock, recovery: recovery,
      calls: calls)
    XCTAssertEqual(calls.count("probe"), 1, "no probe inside the back-off")

    clock.advance(3)
    _ = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock, recovery: recovery,
      calls: calls)
    _ = await recovery.probe.current?.value
    XCTAssertEqual(calls.count("probe"), 2, "the next probe after 5 s")
  }

  func testASilentProbeKeepsTheCooldownSoNoUserReadPaysTheFullDeadline() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let clock = Clock()
    gate.recordStall(at: clock.now)
    let recovery = recovery(calls) { try await Task.sleep(for: .seconds(30)) }
    clock.advance(15)
    _ = try await read(
      bridge: hang(calls), host: answer("ax", calls), gate: gate, clock: clock, recovery: recovery, calls: calls)
    _ = await recovery.probe.current?.value
    clock.advance(10)
    let later = try await read(
      bridge: hang(calls), host: answer("ax", calls), gate: gate, clock: clock, recovery: recovery, calls: calls)
    XCTAssertEqual(later.backend, .ax)
    XCTAssertEqual(calls.count("bridge"), 0, "25 s after the stall the bridge is still only probed")
  }

  func testAnExplicitBridgeReadInTheCooldownWaitsOnlyForTheProbe() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let clock = Clock()
    gate.recordStall(at: clock.now)
    let recovery = recovery(calls, deadlineMs: 100) { try await Task.sleep(for: .seconds(30)) }
    let started = ContinuousClock.now
    do {
      _ = try await read(
        requested: .axbridge, bridge: hang(calls), host: answer("ax", calls), gate: gate,
        policy: BridgeDeadline(readMs: 4000, cooldownSeconds: 20), clock: clock, recovery: recovery, calls: calls)
      XCTFail("expected a timeout")
    } catch {
      let wire = WireError.from(error)
      XCTAssertEqual(wire.code, .timeout)
      XCTAssertTrue(wire.message.contains("axbridge"), wire.message)
    }
    XCTAssertLessThan(ContinuousClock.now - started, .seconds(1), "the probe deadline, not the 4 s read deadline")
    XCTAssertEqual(calls.count("bridge"), 0)
    XCTAssertEqual(calls.count("ax"), 0, "an explicit read never answers from another reader")

    do {
      _ = try await read(
        requested: .axbridge, bridge: hang(calls), host: answer("ax", calls), gate: gate, clock: clock,
        recovery: recovery, calls: calls)
      XCTFail("expected a timeout")
    } catch {
      XCTAssertEqual(WireError.from(error).code, .timeout)
    }
    XCTAssertEqual(calls.count("probe"), 1, "inside the back-off an explicit read fails without probing")
  }

  func testAnExplicitBridgeReadInTheCooldownReadsOnceTheProbeAnswers() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let clock = Clock()
    gate.recordStall(at: clock.now)
    let outcome = try await read(
      requested: .axbridge, bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, clock: clock,
      recovery: recovery(calls) {}, calls: calls)
    XCTAssertEqual(outcome.backend, .axbridge)
    XCTAssertEqual(calls.count("probe"), 1)
    XCTAssertEqual(calls.count("bridge"), 1)
  }

  func testAProbeLiftsAStalledWarmUpSoTheGuestIsNotLeftOnAxForTheSpell() async throws {
    let calls = Calls()
    let gate = BridgeStallGate()
    let warmth = BridgeWarmth()
    let clock = Clock()
    _ = await warmth.warmUp(deadlineMs: 50, log: { _ in }) { try await Task.sleep(for: .seconds(30)) }?.value
    let recovery = recovery(calls) {}
    let first = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy,
      clock: clock, recovery: recovery, calls: calls)
    XCTAssertEqual(first.backend, .ax)
    _ = await recovery.probe.current?.value
    XCTAssertFalse(warmth.isCold, "the probe answered: the guest is warm")
    let next = try await read(
      bridge: answer("bridge", calls), host: answer("ax", calls), gate: gate, warmth: warmth, policy: coldPolicy,
      clock: clock, recovery: recovery, calls: calls)
    XCTAssertEqual(next.backend, .axbridge)
  }
}
