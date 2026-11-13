import FBSimulatorAX
import FBSimulatorControl
import Foundation
import XCTest

@testable import warden_simd

private final class Script: @unchecked Sendable {
  private let lock = NSLock()
  private var calls: [String] = []
  private var boards: [Set<pid_t>]
  var marker: Result<Bool, AXWedgeStepFailed>
  var kickstart: Result<Void, AXWedgeStepFailed>
  var markerDelay: Double
  var silent = true

  init(
    marker: Result<Bool, AXWedgeStepFailed> = .success(true), kickstart: Result<Void, AXWedgeStepFailed> = .success(()),
    boards: [Set<pid_t>] = [[100], [100], [200]], markerDelay: Double = 0
  ) {
    self.marker = marker
    self.kickstart = kickstart
    self.boards = boards
    self.markerDelay = markerDelay
  }

  func note(_ call: String) { lock.withLock { calls.append(call) } }
  var log: [String] { lock.withLock { calls } }

  func nextBoards() -> Set<pid_t> {
    lock.withLock { boards.count > 1 ? boards.removeFirst() : boards.first ?? [] }
  }

  var steps: AXWedgeRecovery.Steps {
    AXWedgeRecovery.Steps(
      markerLogged: { [self] in
        note("log")
        if markerDelay > 0 { try? await Task.sleep(for: .seconds(markerDelay)) }
        return try marker.get()
      },
      readersSilent: { [self] in
        note("liveness")
        return silent
      },
      springBoards: { [self] in nextBoards() },
      restartBackboardd: { [self] in
        note("kickstart")
        try kickstart.get()
      },
      afterRestart: { [self] in note("after") },
      sleep: { _ in await Task.yield() })
  }
}

private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Double = 500
  var now: Double { lock.withLock { value } }
  func advance(_ seconds: Double) { lock.withLock { value += seconds } }
}

/// A freshly booted iOS 27 sim now and then wedges the accessibility notification server in backboardd on its first
/// AX use: both readers then time out for the life of the boot. The helper recognises it (both readers silent, the
/// marker in the sim log), restarts backboardd once, ends its stale guests and reads on.
final class AXWedgeTests: XCTestCase {
  private let silentHost = AccessibilityError.serviceNotAnswering(.query(timeout: 10), elapsed: 10, behindAbandoned: 0)

  private func recovery(_ script: Script, max: Int = 1, clock: Clock = Clock()) -> AXWedgeRecovery {
    AXWedgeRecovery(maxRestarts: max, steps: script.steps, now: { clock.now }, log: { _ in })
  }

  // MARK: configuration

  func testTheBudgetComesFromTheEnvironment() {
    let log: @Sendable (String) -> Void = { _ in }
    XCTAssertEqual(AXWedgeRecovery.configuredMaxRestarts([:], log: log), 1)
    XCTAssertEqual(AXWedgeRecovery.configuredMaxRestarts(["WARDEN_SIMD_AX_WEDGE_RESTARTS": "0"], log: log), 0)
    XCTAssertEqual(AXWedgeRecovery.configuredMaxRestarts(["WARDEN_SIMD_AX_WEDGE_RESTARTS": "3"], log: log), 3)
    XCTAssertEqual(AXWedgeRecovery.configuredMaxRestarts(["WARDEN_SIMD_AX_WEDGE_RESTARTS": "lots"], log: log), 1)
    XCTAssertEqual(AXWedgeRecovery.configuredMaxRestarts(["WARDEN_SIMD_AX_WEDGE_RESTARTS": "-1"], log: log), 1)
  }

  func testOnlyASilentHostServiceCountsAsDead() {
    XCTAssertTrue(AXWedgeRecovery.isServiceSilent(silentHost))
    XCTAssertFalse(AXWedgeRecovery.isServiceSilent(AccessibilityError.elementNotFound(key: "id", value: "x", depth: 1)))
    XCTAssertFalse(AXWedgeRecovery.isServiceSilent(WireError(.timeout, "client")))
  }

  func testLogShowsOwnInvocationLineIsNoWedge() {
    let marker = AXWedgeRecovery.marker
    let selfLine =
      "2026-11-06 18:21:15.014 Df log[94977:0] [com.apple.log:] log run noninteractively, parent: 92654 (launchd_sim), args: 'log' 'show' '--predicate' 'eventMessage CONTAINS \"\(marker)\"'"
    let wedged = "2026-11-06 16:15:32.585 Df SimulatorFrameworkBridge-iOS[2013:3373] (AXRuntime) AXError: \(marker)"
    XCTAssertFalse(AXWedgeRecovery.logNamesWedge("Timestamp Ty Process[PID:TID]\n\(selfLine)\n"))
    XCTAssertTrue(AXWedgeRecovery.logNamesWedge("\(selfLine)\n\(wedged)\n"))
    XCTAssertTrue(AXWedgeRecovery.logPredicate.contains("process != \"log\""))
  }

  // MARK: recovery

  func testAWedgedSimIsRestartedOnceSpringBoardIsBackAndTheGuestsAreReplaced() async throws {
    let script = Script()
    let wedge = recovery(script)
    let outcome = await try XCTUnwrap(wedge.suspect()).value
    guard case .restarted = outcome else { return XCTFail("expected a restart, got \(outcome)") }
    XCTAssertEqual(script.log, ["log", "liveness", "kickstart", "after"])
    XCTAssertEqual(wedge.restarts, 1)
    XCTAssertFalse(wedge.isRecovering)
  }

  func testNoMarkerMeansASlowSimNotAWedgedOneAndNothingIsRestarted() async throws {
    let script = Script(marker: .success(false))
    let wedge = recovery(script)
    let outcome = await try XCTUnwrap(wedge.suspect()).value
    XCTAssertEqual(outcome, .notWedged)
    XCTAssertEqual(script.log, ["log"])
    XCTAssertEqual(wedge.restarts, 0)
  }

  func testAMarkerOnASimWhoseAxReaderAnswersIsNotAWedge() async throws {
    let script = Script()
    script.silent = false
    let wedge = recovery(script)
    let outcome = await try XCTUnwrap(wedge.suspect()).value
    XCTAssertEqual(outcome, .notWedged, "the marker alone is no proof: reads must still time out")
    XCTAssertEqual(script.log, ["log", "liveness"])
    XCTAssertEqual(wedge.restarts, 0)
  }

  func testALogThatCannotBeReadFailsTheCheckWithoutARestart() async throws {
    let script = Script(marker: .failure(AXWedgeStepFailed("log show: exit 1")))
    let outcome = await try XCTUnwrap(recovery(script).suspect()).value
    XCTAssertEqual(outcome, .failed("log show: exit 1"))
    XCTAssertEqual(script.log, ["log"])
  }

  func testAFailedKickstartIsNotCountedAndLeavesTheGuestsAlone() async throws {
    let script = Script(kickstart: .failure(AXWedgeStepFailed("restart backboardd: exit 3")))
    let wedge = recovery(script)
    let outcome = await try XCTUnwrap(wedge.suspect()).value
    XCTAssertEqual(outcome, .failed("restart backboardd: exit 3"))
    XCTAssertEqual(script.log, ["log", "liveness", "kickstart"])
    XCTAssertEqual(wedge.restarts, 0)
  }

  func testASpringBoardThatNeverComesBackStillEndsTheStaleGuests() async throws {
    let script = Script(boards: [[100]])
    let outcome = await try XCTUnwrap(recovery(script).suspect()).value
    guard case .restarted = outcome else { return XCTFail("expected a restart, got \(outcome)") }
    XCTAssertEqual(script.log, ["log", "liveness", "kickstart", "after"])
  }

  func testSuspicionsWhileOneRunsJoinIt() async throws {
    let script = Script(markerDelay: 0.2)
    let wedge = recovery(script)
    let first = try XCTUnwrap(wedge.suspect())
    XCTAssertTrue(wedge.isRecovering)
    let second = try XCTUnwrap(wedge.suspect())
    _ = await first.value
    _ = await second.value
    XCTAssertEqual(script.log.filter { $0 == "log" }.count, 1)
  }

  func testTheBudgetBoundsTheRestartsAndZeroMeansNever() async throws {
    let script = Script()
    let wedge = recovery(script)
    _ = await wedge.suspect()?.value
    XCTAssertNil(wedge.suspect(), "one restart per helper by default")
    XCTAssertNil(recovery(Script(), max: 0).suspect(), "WARDEN_SIMD_AX_WEDGE_RESTARTS=0 never checks")
  }

  func testANotWedgedVerdictIsNotAskedAgainForAMinuteUnlessForced() async throws {
    let clock = Clock()
    let script = Script(marker: .success(false))
    let wedge = recovery(script, clock: clock)
    _ = await wedge.suspect()?.value
    clock.advance(30)
    XCTAssertNil(wedge.suspect())
    XCTAssertNotNil(wedge.check(force: true), "an explicit ask (the warm-up) is never held back by the window")
    _ = await wedge.current?.value
    clock.advance(61)
    XCTAssertNotNil(wedge.suspect())
  }

  func testTheStateSaysWhatHappenedAndHowLongAgo() async throws {
    let clock = Clock()
    let wedge = recovery(Script(), max: 2, clock: clock)
    XCTAssertEqual(wedge.state(), ["restarts": 0, "maxRestarts": 2, "recovering": false])
    _ = await wedge.suspect()?.value
    clock.advance(4)
    let state = try XCTUnwrap(wedge.state().objectValue)
    XCTAssertEqual(state["restarts"], 1)
    let last = try XCTUnwrap(state["last"]?.objectValue)
    XCTAssertEqual(last["outcome"], "restarted")
    XCTAssertEqual(last["agoMs"], 4000)
  }

  func testAReadWaitsForARecoveryInFlightAndSaysSoWhenItOutlastsTheWait() async throws {
    let wedge = recovery(Script(markerDelay: 0.3))
    _ = wedge.suspect()
    let stillRecovering = await wedge.waitWhileRecovering(ms: 20)
    XCTAssertTrue(stillRecovering)
    let error = wedge.recoveringError()
    XCTAssertEqual(error.code, .timeout)
    XCTAssertTrue(error.retryable)
    XCTAssertEqual(error.detail?.objectValue?["reason"], "ax_wedge_recovering")
    let after = await wedge.waitWhileRecovering(ms: 2000)
    XCTAssertFalse(after)
  }

  func testAnExplicitAskSaysWhatItsOwnCheckFoundAndNothingOnceTheBudgetIsSpent() async throws {
    let wedge = recovery(Script())
    let first = await Session.axWedge(wedge, recover: true)
    XCTAssertEqual(first.objectValue?["checked"], "restarted")
    let again = await Session.axWedge(wedge, recover: true)
    XCTAssertNil(again.objectValue?["checked"], "the budget is spent: the old restart is not this ask's")
    XCTAssertEqual(again.objectValue?["restarts"], 1)
  }

  // MARK: readAX

  private func readAX(
    bridge: @escaping @Sendable () async throws -> String, host: @escaping @Sendable () async throws -> String,
    wedge: AXWedgeRecovery
  ) async throws -> AXOutcome<String> {
    try await Session.readAX(
      requested: nil, bridge: bridge, host: host, recover: { _ in },
      policy: BridgeDeadline(readMs: 50, coldReadMs: 50, cooldownSeconds: 20), gate: BridgeStallGate(),
      warmth: .warmed(), health: BridgeHealth(), now: { 1000 }, log: { _ in }, bridgeName: "available",
      wedge: wedge)
  }

  func testBothReadersSilentStartsACheckAndTheFailedReadSaysSo() async throws {
    let script = Script(markerDelay: 0.2)
    let wedge = recovery(script)
    let silent = silentHost
    do {
      _ = try await readAX(
        bridge: {
          try await Task.sleep(for: .seconds(5))
          return "late"
        }, host: { throw silent }, wedge: wedge)
      XCTFail("both readers failed")
    } catch let error as AXReadersFailed {
      XCTAssertEqual(error.stall?.axWedge, "checking")
    }
    XCTAssertTrue(wedge.isRecovering)
    _ = await wedge.current?.value
    XCTAssertEqual(wedge.restarts, 1)
  }

  func testABridgeErrorThatIsNotSilenceDoesNotCheck() async throws {
    let wedge = recovery(Script())
    let silent = silentHost
    _ = try? await readAX(
      bridge: { throw AXBridgeError.bridgeUnavailable }, host: { throw silent }, wedge: wedge)
    XCTAssertNil(wedge.current)
  }

  func testAFallbackAfterARestartCarriesTheCount() async throws {
    let wedge = recovery(Script())
    _ = await wedge.suspect()?.value
    let outcome = try await readAX(
      bridge: {
        try await Task.sleep(for: .seconds(5))
        return "late"
      }, host: { "ax" }, wedge: wedge)
    XCTAssertEqual(outcome.fallback?.stall?.axWedgeRestarts, 1)
    XCTAssertEqual(outcome.fallback?.stall?.json.objectValue?["axWedgeRestarts"], 1)
  }
}
