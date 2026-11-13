import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import Foundation
import XCTest

@testable import warden_simd

private final class Ticks: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Double = 1000
  var now: Double { lock.withLock { value } }
  func advance(_ seconds: Double) { lock.withLock { value += seconds } }
}

/// A bridge fallback or stall carries what happened (`BridgeStallReport`): where it failed, how long the read ran
/// against which deadline, how old the guest was, whether it was cold, how much cooldown is left and how many bridge
/// reads in a row have failed. The client records it in the run's evidence.
final class BridgeStallReportTests: XCTestCase {
  private let policy = BridgeDeadline(readMs: 100, coldReadMs: 300, cooldownSeconds: 20)

  private let hang: @Sendable () async throws -> String = {
    try await Task.sleep(for: .seconds(30))
    return "late"
  }

  private let host: @Sendable () async throws -> String = { "ax" }
  private let bridgeOK: @Sendable () async throws -> String = { "bridge" }

  private func read(
    requested: AXBackend? = nil,
    bridge: (@Sendable () async throws -> String)?,
    host: (@Sendable () async throws -> String)?,
    gate: BridgeStallGate,
    warmth: BridgeWarmth = .warmed(),
    ticks: Ticks = Ticks(),
    guestAge: Double? = 7.5,
    recovery: BridgeRecovery? = nil,
    reaper: BridgeReaper? = nil
  ) async throws -> AXOutcome<String> {
    try await Session.readAX(
      requested: requested, bridge: bridge, host: host, recover: { _ in }, policy: policy, gate: gate,
      warmth: warmth, health: BridgeHealth(), recovery: recovery, reaper: reaper, now: { ticks.now }, log: { _ in },
      bridgeName: "available", guestAgeSeconds: { guestAge })
  }

  func testAWarmStallReportsTheReadAgainstItsDeadline() async throws {
    let outcome = try await read(bridge: hang, host: host, gate: BridgeStallGate())
    let report = try XCTUnwrap(outcome.fallback?.stall)
    XCTAssertEqual(report.stage, .read)
    XCTAssertEqual(report.deadlineMs, 100)
    XCTAssertGreaterThanOrEqual(report.readMs ?? 0, 100)
    XCTAssertFalse(report.cold)
    XCTAssertEqual(report.guestAgeMs, 7500)
    XCTAssertEqual(report.cooldownRemainingMs, 20_000, "a warm stall arms the full cooldown")
    XCTAssertEqual(report.probes, 1)
  }

  func testAColdStallSaysColdAndLeavesNoCooldown() async throws {
    let outcome = try await read(bridge: hang, host: host, gate: BridgeStallGate(), warmth: BridgeWarmth())
    let report = try XCTUnwrap(outcome.fallback?.stall)
    XCTAssertTrue(report.cold)
    XCTAssertEqual(report.deadlineMs, 300)
    XCTAssertNil(report.cooldownRemainingMs, "the cold guest's first stall arms no cooldown")
  }

  func testAReadInsideTheCooldownReportsWhatIsLeftAndTheFailedProbes() async throws {
    let gate = BridgeStallGate()
    let ticks = Ticks()
    _ = try await read(bridge: hang, host: host, gate: gate, ticks: ticks)
    ticks.advance(5)
    let skipped = try await read(bridge: bridgeOK, host: host, gate: gate, ticks: ticks)
    let report = try XCTUnwrap(skipped.fallback?.stall)
    XCTAssertEqual(report.stage, .cooldown)
    XCTAssertNil(report.readMs, "the bridge was not asked")
    XCTAssertEqual(report.cooldownRemainingMs, 15_000)
    XCTAssertEqual(report.probes, 1)
  }

  func testProbesCountTheBridgeFailuresInARowAndAnAnswerResetsThem() async throws {
    let gate = BridgeStallGate()
    let ticks = Ticks()
    _ = try await read(bridge: hang, host: host, gate: gate, ticks: ticks)
    ticks.advance(25)
    let second = try await read(bridge: hang, host: host, gate: gate, ticks: ticks)
    XCTAssertEqual(second.fallback?.stall?.probes, 2)
    ticks.advance(25)
    _ = try await read(bridge: bridgeOK, host: host, gate: gate, ticks: ticks)
    XCTAssertEqual(gate.failuresInARow, 0)
  }

  func testAFailedBridgeReadIsAReadStageWithoutADeadlineHit() async throws {
    let outcome = try await read(
      bridge: { throw AXBridgeError.guestNotAnswering(after: 5) }, host: host, gate: BridgeStallGate())
    let report = try XCTUnwrap(outcome.fallback?.stall)
    XCTAssertEqual(report.stage, .read)
    XCTAssertEqual(report.probes, 1)
  }

  func testNoBridgeReaderIsAConnectStage() async throws {
    let outcome = try await read(bridge: nil, host: host, gate: BridgeStallGate())
    XCTAssertEqual(outcome.fallback?.stall?.stage, .connect)
  }

  func testAnExplicitBridgeStallCarriesTheReportOnTheWire() async throws {
    do {
      _ = try await read(requested: .axbridge, bridge: hang, host: host, gate: BridgeStallGate())
      XCTFail("expected a timeout")
    } catch {
      let wire = WireError.from(error)
      XCTAssertEqual(wire.code, .timeout)
      XCTAssertEqual(wire.detail?["stage"], "axbridge", "the old field keeps its meaning")
      let stall = try XCTUnwrap(wire.detail?["stall"])
      XCTAssertEqual(stall["stage"], "read")
      XCTAssertEqual(stall["deadlineMs"], .int(100))
      XCTAssertEqual(stall["cold"], .bool(false))
      XCTAssertEqual(stall["probes"], .int(1))
    }
  }

  func testBothReadersFailingKeepsTheReport() async throws {
    do {
      _ = try await read(
        bridge: hang, host: { throw AXBridgeError.guestNotAnswering(after: 1) }, gate: BridgeStallGate())
      XCTFail("expected both readers to fail")
    } catch {
      let wire = WireError.from(error)
      XCTAssertEqual(wire.detail?["stall"]?["stage"], "read")
    }
  }

  func testTheReportJSONOmitsWhatIsUnknown() {
    let report = BridgeStallReport(
      stage: .connect, readMs: nil, deadlineMs: nil, guestAgeMs: nil, cold: true, cooldownRemainingMs: nil, probes: 0)
    XCTAssertEqual(report.json, ["stage": "connect", "cold": true, "probes": 0])
  }

  private func silentProbe(deadlineMs: Int = 50) -> BridgeRecovery {
    BridgeRecovery(
      probe: BridgeProbe(deadlineMs: deadlineMs, intervalSeconds: 5),
      check: { try await Task.sleep(for: .seconds(30)) })
  }

  func testASilentBackgroundProbeCountsAsAFailedProbe() async throws {
    let gate = BridgeStallGate()
    let ticks = Ticks()
    let recovery = silentProbe()
    _ = try await read(bridge: hang, host: host, gate: gate, ticks: ticks, recovery: recovery)
    XCTAssertEqual(gate.failuresInARow, 1)
    ticks.advance(1)
    let skipped = try await read(bridge: bridgeOK, host: host, gate: gate, ticks: ticks, recovery: recovery)
    XCTAssertEqual(skipped.fallback?.stall?.stage, .cooldown)
    let outcome = await recovery.probe.current?.value
    XCTAssertEqual(outcome, .silent(afterMs: 50))
    XCTAssertEqual(gate.failuresInARow, 2, "the silent probe is the second failure in a row")
  }

  func testAnExplicitReadFailedByTheProbeReportsTheCooldownAndTheProbeDeadline() async throws {
    let gate = BridgeStallGate()
    let ticks = Ticks()
    gate.recordStall(at: ticks.now)
    gate.recordFailure()
    do {
      _ = try await read(
        requested: .axbridge, bridge: bridgeOK, host: host, gate: gate, ticks: ticks, recovery: silentProbe())
      XCTFail("expected a stall")
    } catch {
      let stall = try XCTUnwrap(WireError.from(error).detail?["stall"])
      XCTAssertEqual(stall["stage"], "cooldown")
      XCTAssertEqual(stall["deadlineMs"], .int(50))
      XCTAssertEqual(stall["probes"], .int(2))
      XCTAssertNil(stall["readMs"], "no tree read was made")
    }
  }

  func testAStallReportsTheGuestsRecycledBeforeIt() async throws {
    let reaper = BridgeReaper(maxRecycles: 2) { 1 }
    let ticks = Ticks()
    let gate = BridgeStallGate()
    let first = try await read(bridge: hang, host: host, gate: gate, ticks: ticks, reaper: reaper)
    XCTAssertEqual(first.fallback?.stall?.recycles, 0, "the recycle this stall starts is not in its own report")
    await reaper.current?.value
    ticks.advance(25)
    let second = try await read(bridge: hang, host: host, gate: gate, warmth: .warmed(), ticks: ticks, reaper: reaper)
    XCTAssertEqual(second.fallback?.stall?.recycles, 1)
    XCTAssertEqual(second.fallback?.stall?.recyclesExhausted, false)
    await reaper.current?.value
    ticks.advance(25)
    let third = try await read(bridge: hang, host: host, gate: gate, warmth: .warmed(), ticks: ticks, reaper: reaper)
    XCTAssertEqual(third.fallback?.stall?.recycles, 2)
    XCTAssertEqual(third.fallback?.stall?.recyclesExhausted, true)
  }

  func testTheFirstReadOfARecycledGuestReportsACold() async throws {
    let reaper = BridgeReaper(maxRecycles: 2) { 1 }
    let ticks = Ticks()
    let gate = BridgeStallGate()
    let warmth = BridgeWarmth.warmed()
    _ = try await read(bridge: hang, host: host, gate: gate, warmth: warmth, ticks: ticks, reaper: reaper)
    await reaper.current?.value
    ticks.advance(25)
    let next = try await read(
      bridge: hang, host: host, gate: gate, warmth: warmth, ticks: ticks, guestAge: 0.2, reaper: reaper)
    let report = try XCTUnwrap(next.fallback?.stall)
    XCTAssertEqual(report.stage, .read)
    XCTAssertTrue(report.cold)
    XCTAssertEqual(report.deadlineMs, 300)
    XCTAssertEqual(report.guestAgeMs, 200, "the guest's age restarts with the recycle")
    XCTAssertNil(report.cooldownRemainingMs, "its first stall is exempt: no cooldown")
    XCTAssertEqual(report.probes, 2)
    XCTAssertEqual(report.recycles, 1)
    XCTAssertFalse(report.recyclesExhausted)
  }

  func testTheReportJSONCarriesRecyclesOnlyOnceOneRan() {
    var report = BridgeStallReport(
      stage: .read, readMs: 4001, deadlineMs: 4000, guestAgeMs: 300, cold: true, cooldownRemainingMs: nil, probes: 1)
    XCTAssertNil(report.json["recycles"])
    XCTAssertNil(report.json["recyclesExhausted"])
    report.recycles = 3
    report.recyclesExhausted = true
    XCTAssertEqual(report.json["recycles"], .int(3))
    XCTAssertEqual(report.json["recyclesExhausted"], .bool(true))
  }

  func testHealthNamesTheRecyclesOnceOneRan() async {
    let reaper = BridgeReaper(maxRecycles: 1) { 2 }
    XCTAssertNil(reaper.healthJSON, "nothing to say before a recycle")
    await reaper.recycleAfterStall(log: { _ in })?.value
    XCTAssertEqual(reaper.healthJSON, ["count": 1, "exhausted": true])
  }
}
