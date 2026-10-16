import FBSimulatorAX
import FBSimulatorControl
import Foundation
import XCTest

@testable import warden_simd

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  private var lines: [String] = []
  func bump() { lock.withLock { value += 1 } }
  func add(_ line: String) { lock.withLock { lines.append(line) } }
  var count: Int { lock.withLock { value } }
  var logged: [String] { lock.withLock { lines } }
}

private final class PidBox: @unchecked Sendable {
  private let lock = NSLock()
  private var pid: pid_t?
  func set(_ pid: pid_t?) { lock.withLock { self.pid = pid } }
  var value: pid_t? { lock.withLock { pid } }
}

/// An app relaunched while no quiescence stream was open answers the bridge with "did not respond" until a stream
/// binds to it; `readRecovering` opens that stream and reads again, and `health` stops claiming the bridge is fine.
final class RelaunchRecoveryTests: XCTestCase {
  private let notResponding = AXBridgeError.applicationNotResponding(pid: 42)

  /// A read that fails with each scripted error in turn, then returns "ok".
  private func script(_ errors: [any Error], calls: Counter) -> () async throws -> String {
    var remaining = errors
    return {
      calls.bump()
      if !remaining.isEmpty { throw remaining.removeFirst() }
      return "ok"
    }
  }

  func testAReadThatWorksNeverRecovers() async throws {
    let reads = Counter()
    let recovers = Counter()
    let value = try await Session.readRecovering(
      read: script([], calls: reads), recover: { _ in recovers.bump() }, log: { _ in })
    XCTAssertEqual(value, "ok")
    XCTAssertEqual(reads.count, 1)
    XCTAssertEqual(recovers.count, 0)
  }

  func testNotRespondingRecoversOnceThenReadsAgain() async throws {
    let reads = Counter()
    let recovers = Counter()
    let logs = Counter()
    let value = try await Session.readRecovering(
      read: script([notResponding], calls: reads), recover: { _ in recovers.bump() }, log: { logs.add($0) })
    XCTAssertEqual(value, "ok")
    XCTAssertEqual(reads.count, 2)
    XCTAssertEqual(recovers.count, 1)
    XCTAssertEqual(logs.logged.count, 1)
    XCTAssertTrue(logs.logged[0].contains("did not respond"))
  }

  /// The failing process is handed to `recover`, so a stream that already follows it is not restarted.
  func testRecoverIsToldWhichProcessDidNotRespond() async throws {
    let reads = Counter()
    let named = PidBox()
    _ = try await Session.readRecovering(
      read: script([notResponding], calls: reads), recover: { named.set($0) }, log: { _ in })
    XCTAssertEqual(named.value, 42)
    XCTAssertEqual(Session.notRespondingPid(notResponding), 42)
    XCTAssertEqual(
      Session.notRespondingPid(UIAutomationError.applicationNotResponding(backend: .accessibility, pid: 7)), 7)
    XCTAssertNil(Session.notRespondingPid(AXBridgeError.applicationUnavailable(pid: 42)))
  }

  func testTheUIAutomationFlavourOfNotRespondingRecoversToo() async throws {
    let reads = Counter()
    let recovers = Counter()
    let error = UIAutomationError.applicationNotResponding(backend: .accessibility, pid: 1)
    _ = try await Session.readRecovering(
      read: script([error], calls: reads), recover: { _ in recovers.bump() }, log: { _ in })
    XCTAssertEqual(recovers.count, 1)
  }

  func testASecondFailureAfterRecoveryPropagatesWithoutRecoveringAgain() async {
    let reads = Counter()
    let recovers = Counter()
    do {
      _ = try await Session.readRecovering(
        read: script([notResponding, notResponding], calls: reads), recover: { _ in recovers.bump() }, log: { _ in })
      XCTFail("expected the second failure to propagate")
    } catch {
      XCTAssertTrue(Session.isNotResponding(error))
    }
    XCTAssertEqual(reads.count, 2)
    XCTAssertEqual(recovers.count, 1)
  }

  func testOtherFailuresDoNotRecover() async {
    let reads = Counter()
    let recovers = Counter()
    do {
      _ = try await Session.readRecovering(
        read: script([AXBridgeError.applicationUnavailable(pid: 42)], calls: reads), recover: { _ in recovers.bump() },
        log: { _ in })
      XCTFail("expected the failure to propagate")
    } catch {
      XCTAssertFalse(Session.isNotResponding(error))
    }
    XCTAssertEqual(reads.count, 1)
    XCTAssertEqual(recovers.count, 0)
  }

  // MARK: monitor

  func testRecoverOpensAFreshStreamAndWaitsForItsFirstState() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    let recovery = Task { await monitor.recover(timeoutMs: 5000) }
    await reader.waitOpened(2)
    let began = ContinuousClock.now
    try await Task.sleep(for: .milliseconds(100))
    reader.emit(.state(.quiet, pid: 200))
    await recovery.value
    XCTAssertGreaterThanOrEqual(ContinuousClock.now - began, .milliseconds(90), "returned before the stream reported")
    await monitor.stop()
  }

  func testRecoverGivesUpAtTheTimeoutWhenTheStreamStaysSilent() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let began = ContinuousClock.now
    await monitor.recover(timeoutMs: 200)
    let elapsed = ContinuousClock.now - began
    XCTAssertGreaterThanOrEqual(elapsed, .milliseconds(190))
    XCTAssertLessThan(elapsed, .seconds(3))
    await monitor.stop()
  }

  // MARK: stream lifetime

  func testTheStreamStaysOpenForTheHelpersLifetimeByDefault() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader, idleCloseSeconds: nil)
    await monitor.start()
    await reader.waitOpened(1)
    try await Task.sleep(for: .milliseconds(800))
    await monitor.start()
    try await Task.sleep(for: .milliseconds(100))
    let opened = reader.opened
    XCTAssertEqual(opened, 1, "an unused stream was closed and reopened")
    await monitor.stop()
  }

  func testAnIdleLimitClosesTheStreamAndTheNextStartReopensIt() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader, idleCloseSeconds: 0.3)
    await monitor.start()
    await reader.waitOpened(1)
    try await Task.sleep(for: .milliseconds(900))
    await monitor.start()
    await reader.waitOpened(2)
    await monitor.stop()
  }

  func testIdleCloseIsConfiguredFromTheEnvironmentAndOffByDefault() {
    XCTAssertNil(QuiescenceMonitor.configuredIdleCloseSeconds([:]))
    XCTAssertNil(QuiescenceMonitor.configuredIdleCloseSeconds(["WARDEN_SIMD_STREAM_IDLE_S": "0"]))
    XCTAssertNil(QuiescenceMonitor.configuredIdleCloseSeconds(["WARDEN_SIMD_STREAM_IDLE_S": "soon"]))
    XCTAssertEqual(QuiescenceMonitor.configuredIdleCloseSeconds(["WARDEN_SIMD_STREAM_IDLE_S": "10"]), 10)
  }

  // MARK: health

  func testHealthIsAvailableUntilAReadFails() {
    let fields = Session.axFields(axDefault: "axbridge", status: .available, lastFailure: nil, now: 10)
    XCTAssertEqual(fields["bridge"], "available")
    XCTAssertNil(fields["lastError"])
  }

  func testHealthIsDegradedWithTheLastErrorAfterAFailedRead() {
    let failure = BridgeHealth.Failure(message: "pid 7 did not respond", at: 8)
    let fields = Session.axFields(axDefault: "axbridge", status: .available, lastFailure: failure, now: 10)
    XCTAssertEqual(fields["bridge"], "degraded")
    XCTAssertEqual(fields["lastError"]?["message"], "pid 7 did not respond")
    XCTAssertEqual(fields["lastError"]?["agoMs"], .int(2000))
  }

  func testAFailedProbeStaysFailedRatherThanDegraded() {
    let failure = BridgeHealth.Failure(message: "x", at: 0)
    let fields = Session.axFields(axDefault: "axbridge", status: .failed("probe failed"), lastFailure: failure, now: 1)
    XCTAssertEqual(fields["bridge"], "failed")
    XCTAssertNil(fields["lastError"])
  }

  func testBridgeHealthRecordsAndClears() {
    let health = BridgeHealth()
    XCTAssertNil(health.lastFailure)
    health.recordFailure("boom", at: 3)
    XCTAssertEqual(health.lastFailure, BridgeHealth.Failure(message: "boom", at: 3))
    health.recordSuccess()
    XCTAssertNil(health.lastFailure)
  }
}
