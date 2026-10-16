import CoreGraphics
import FBSimulatorAX
import Foundation
import XCTest

@testable import warden_simd

/// A quiescence source the test drives by hand: `emit` pushes events into the stream the monitor last opened.
final class FakeReader: UIAutomation, @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: AsyncThrowingStream<QuiescenceEvent, Error>.Continuation?
  private(set) var opened = 0
  /// Every `quiescence` call, including ones cancelled while still opening.
  private(set) var requests = 0
  /// How long opening a stream takes (a loaded machine: seconds).
  var openDelay: Duration = .zero
  /// While true, every open blocks until `releaseOpens()` (a deterministic "still opening" window).
  var holdOpens = false
  private var heldOpens: [CheckedContinuation<Void, Never>] = []

  func quiescence(
    _ query: AccessibilityElementQuery, parameters: QuiescenceParameters
  ) async throws -> AsyncThrowingStream<QuiescenceEvent, Error> {
    lock.withLock { requests += 1 }
    if openDelay > .zero { try await Task.sleep(for: openDelay) }
    if lock.withLock({ holdOpens }) {
      await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        let held = lock.withLock { () -> Bool in
          guard holdOpens else { return false }
          heldOpens.append(c)
          return true
        }
        if !held { c.resume() }
      }
      try Task.checkCancellation()
    }
    let (stream, continuation) = AsyncThrowingStream<QuiescenceEvent, Error>.makeStream()
    lock.withLock {
      self.continuation?.finish()
      self.continuation = continuation
      opened += 1
    }
    return stream
  }

  /// Lets every held open complete; later opens complete at once.
  func releaseOpens() {
    let held = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      holdOpens = false
      defer { heldOpens.removeAll() }
      return heldOpens
    }
    for c in held { c.resume() }
  }

  func emit(_ event: QuiescenceEvent) {
    lock.withLock { continuation }?.yield(event)
  }

  /// Waits for the `count`-th stream to open; fails the test instead of hanging when it never does (a scheduling
  /// stall on a loaded machine once turned a missed restart into a hung `swift test`).
  func waitOpened(_ count: Int = 1, timeoutMs: Int = 10_000) async {
    let deadline = ContinuousClock.now + .milliseconds(timeoutMs)
    while lock.withLock({ opened }) < count {
      if ContinuousClock.now >= deadline {
        XCTFail("stream \(count) did not open within \(timeoutMs) ms (opened \(lock.withLock { opened }))")
        return
      }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  private func unsupported() -> UIAutomationError {
    .operationUnsupported(backend: .accessibility, operation: "fake")
  }

  func describe(_ query: AccessibilityElementQuery, options: AccessibilityRequestOptions) async throws
    -> AccessibilityElementsResponse
  { throw unsupported() }
  func hitTest(at point: CGPoint, options: AccessibilityRequestOptions) async throws -> AccessibilityElementsResponse? {
    throw unsupported()
  }
  func tap(_ query: AccessibilityElementQuery, options: TapOptions) async throws { throw unsupported() }
  func setValue(_ value: String, for query: AccessibilityElementQuery) async throws { throw unsupported() }
  func wait(_ query: AccessibilityElementQuery, timeout: TimeInterval, pollInterval: TimeInterval) async throws {
    throw unsupported()
  }
  func scroll(_ query: AccessibilityElementQuery, direction: AccessibilityScrollDirection) async throws {
    throw unsupported()
  }
  func frame(_ query: AccessibilityElementQuery) async throws -> CGRect { throw unsupported() }
  func drag(from source: AccessibilityElementQuery, to destination: AccessibilityElementQuery, options: DragOptions)
    async throws
  { throw unsupported() }
}

/// Hands out pids from a script, one per call; the last entry repeats.
private final class PidScript: @unchecked Sendable {
  private let lock = NSLock()
  private var pids: [pid_t?]
  private(set) var calls = 0

  init(_ pids: [pid_t?]) { self.pids = pids }

  var resolver: PidResolver {
    { [self] _ in
      lock.withLock {
        calls += 1
        return pids.count > 1 ? pids.removeFirst() : pids[0]
      }
    }
  }
}

final class SettleFrontmostTests: XCTestCase {
  private let springboard: pid_t = 100
  private let app: pid_t = 200

  // MARK: request parsing

  func testBundleIdIsOptionalAndMustBeANonEmptyString() throws {
    XCTAssertNil(try SettleRequest([:]).bundleId)
    XCTAssertNil(try SettleRequest(["bundleId": .null]).bundleId)
    XCTAssertEqual(try SettleRequest(["bundleId": "a.b"]).bundleId, "a.b")
    for bad: JSON in [.string(""), .int(3), .bool(true)] {
      XCTAssertThrowsError(try SettleRequest(["bundleId": bad])) { error in
        XCTAssertEqual((error as? WireError)?.code, .badRequest)
      }
    }
  }

  // MARK: gate

  func testGateNeedsAResolvedPidAndAnEqualFrontmostPid() {
    var gate = FrontmostGate(bundleId: "a.b")
    XCTAssertFalse(gate.matches(frontmostPid: springboard))
    gate.resolved(pid: app, now: 0)
    XCTAssertFalse(gate.matches(frontmostPid: springboard))
    XCTAssertFalse(gate.matches(frontmostPid: nil))
    XCTAssertTrue(gate.matches(frontmostPid: app))
  }

  func testGateResolvesOnlyWhileTheyDisagreeAndNoOftenerThanTheInterval() {
    var gate = FrontmostGate(bundleId: "a.b")
    XCTAssertTrue(gate.shouldResolve(frontmostPid: springboard, now: 0))
    gate.resolved(pid: nil, now: 0)
    XCTAssertFalse(gate.shouldResolve(frontmostPid: springboard, now: 0.1))
    XCTAssertTrue(gate.shouldResolve(frontmostPid: springboard, now: 0.16))
    gate.resolved(pid: app, now: 0.16)
    XCTAssertFalse(gate.shouldResolve(frontmostPid: app, now: 5), "matching needs no launchd call")
    XCTAssertTrue(gate.shouldResolve(frontmostPid: 300, now: 5), "a relaunched app has a new pid")
  }

  func testGateNeverRestartsWithoutAnExistingTargetPid() {
    var gate = FrontmostGate(bundleId: "a.b")
    gate.resolved(pid: nil, now: 0)
    for now in stride(from: 0.0, through: 5.0, by: 0.5) {
      XCTAssertFalse(gate.shouldRestart(frontmostPid: springboard, now: now), "no pid yet at \(now)")
    }
  }

  func testGateRestartsOnceTheNewPidHasExistedForTheGraceThenBacksOff() {
    var gate = FrontmostGate(bundleId: "a.b")
    gate.resolved(pid: nil, now: 0)
    gate.resolved(pid: app, now: 3)
    XCTAssertFalse(gate.shouldRestart(frontmostPid: springboard, now: 3), "pid just appeared: give the stream a chance to follow")
    XCTAssertFalse(gate.shouldRestart(frontmostPid: springboard, now: 3.4))
    XCTAssertTrue(gate.shouldRestart(frontmostPid: springboard, now: 3.5))
    gate.restarted(now: 3.5)
    XCTAssertFalse(gate.shouldRestart(frontmostPid: springboard, now: 3.6), "a fresh stream needs time to bind")
    XCTAssertFalse(gate.shouldRestart(frontmostPid: springboard, now: 4.9))
    XCTAssertTrue(gate.shouldRestart(frontmostPid: springboard, now: 5.0), "still latched: try again")
  }

  func testGateStopsRestartingOnceTheStreamFollows() {
    var gate = FrontmostGate(bundleId: "a.b")
    gate.resolved(pid: app, now: 0)
    XCTAssertFalse(gate.shouldRestart(frontmostPid: app, now: 10))
    gate.resolved(pid: 300, now: 11)
    XCTAssertFalse(gate.shouldRestart(frontmostPid: app, now: 11.2), "a newer relaunch restarts the grace")
    XCTAssertTrue(gate.shouldRestart(frontmostPid: app, now: 11.5))
  }

  // MARK: waitQuiet

  /// terminate + launch, then `settle` at once: the stream still reports the dead app's neighbour, then nothing,
  /// then the app; the stream must not be restarted while the app has no pid (that stream would latch SpringBoard).
  func testScriptedRelaunchOldPidNoPidNewPidBusyQuiet() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 50, timeoutMs: 8000, bundleId: "a.b", resolvePid: script.resolver)
    }
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: springboard))
    try await Task.sleep(for: .milliseconds(1700))
    XCTAssertEqual(reader.opened, 1, "no restart while the bundle has no pid")
    try await Task.sleep(for: .milliseconds(300))
    reader.emit(.targetChanged(pid: app))
    reader.emit(.state(.busy([.runLoopIdle]), pid: app))
    try await Task.sleep(for: .milliseconds(100))
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertNil(outcome.reason)
    XCTAssertEqual(reader.opened, 1, "the stream followed the app by itself")
    await monitor.stop()
  }

  /// The premature-restart case: the pid exists but the stream stays latched on the old app, so it is restarted
  /// (after the pid exists, never before), and quiet counts only from the new stream's state for the target pid.
  func testRestartsOnlyAfterThePidExistsAndCountsQuietFromTheTargetPidOnly() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([nil, nil, nil, app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 0, timeoutMs: 8000, bundleId: "a.b", resolvePid: script.resolver)
    }
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: springboard))
    try await Task.sleep(for: .milliseconds(450))
    XCTAssertEqual(reader.opened, 1, "pid still missing: restarting now would latch the old app")
    await reader.waitOpened(2)
    reader.emit(.state(.quiet, pid: springboard))
    try await Task.sleep(for: .milliseconds(300))
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertEqual(reader.opened, 2)
    await monitor.stop()
  }

  /// A booting app answers no quiescence signal for a while: the stuck-stream restart reopens the stream, which
  /// reports no pid until the app answers. That must not look like a stale stream and be restarted again at once
  /// (observed live: three restarts within 20 ms, each cancelling the previous one before it bound).
  func testAStuckRestartBacksOffTheFrontmostRestart() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 0, timeoutMs: 8000, bundleId: "a.b", resolvePid: script.resolver)
    }
    await reader.waitOpened()
    reader.emit(.targetChanged(pid: app))
    reader.emit(.state(.busy([.runLoopIdle, .animationsInactive]), pid: app))
    await reader.waitOpened(2)
    // well inside FrontmostGate.repeatRestartMs (1500): the sleep may overrun on a loaded runner
    try await Task.sleep(for: .milliseconds(900))
    XCTAssertEqual(reader.opened, 2, "the reopened stream is given time to bind before another restart")
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertEqual(outcome.via, "stream")
    await monitor.stop()
  }

  /// Under load opening a stream takes seconds; restarting one that has not finished opening only throws that work
  /// away (observed live: a reopen cancelled 2.2 s into its opening).
  func testNoRestartWhileTheStreamIsStillOpening() async throws {
    let reader = FakeReader()
    // held, not delayed: a sleep racing a delay flaked on a loaded CI runner (the open completed first, the
    // unbound stream was restarted every 1.5 s and the test's quiet event went to a cancelled stream)
    reader.holdOpens = true
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 0, timeoutMs: 8000, bundleId: "a.b", resolvePid: script.resolver)
    }
    try await Task.sleep(for: .milliseconds(1500))
    XCTAssertEqual(reader.requests, 1, "the first open is still in flight and must not be restarted")
    reader.releaseOpens()
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertEqual(reader.requests, 1)
    await monitor.stop()
  }

  /// A stream that has just opened reports its target a few ms later. With the bundle's pid already old, that gap
  /// must not count as a latched stream (observed live: a restart 3 ms after the stream opened).
  func testAFreshlyOpenedStreamGetsTimeToBindBeforeARestart() async throws {
    let reader = FakeReader()
    reader.holdOpens = true
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 0, timeoutMs: 8000, bundleId: "a.b", resolvePid: script.resolver)
    }
    try await Task.sleep(for: .milliseconds(700))  // the pid is now older than the first-restart grace
    reader.releaseOpens()
    await reader.waitOpened()
    try await Task.sleep(for: .milliseconds(200))
    XCTAssertEqual(reader.requests, 1, "a stream that opened 200 ms ago is still binding, not latched")
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertEqual(reader.requests, 1)
    await monitor.stop()
  }

  /// The restarted stream binds to the old app again (the new app is still launching): it is restarted once more.
  func testALatchedRestartIsRetried() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 0, timeoutMs: 8000, bundleId: "a.b", resolvePid: script.resolver)
    }
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: springboard))
    await reader.waitOpened(2)
    reader.emit(.state(.quiet, pid: springboard))
    await reader.waitOpened(3)
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertEqual(reader.opened, 3)
    await monitor.stop()
  }

  func testWithoutABundleIdThePreviousFrontmostAppCountsAsQuiet() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let wait = Task { try await monitor.waitQuiet(quietMs: 0, timeoutMs: 2000) }
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: springboard))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    await monitor.stop()
  }

  func testWaitsForTheNamedAppToBecomeFrontmostThenForItToBeQuiet() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([nil, nil, app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 50, timeoutMs: 5000, bundleId: "a.b", resolvePid: script.resolver)
    }
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: springboard))
    try await Task.sleep(for: .milliseconds(400))
    reader.emit(.targetChanged(pid: app))
    reader.emit(.state(.busy([.runLoopIdle]), pid: app))
    try await Task.sleep(for: .milliseconds(100))
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertNil(outcome.reason)
    XCTAssertGreaterThanOrEqual(script.calls, 3, "asked launchd until the app was running")
    await monitor.stop()
  }

  func testAlreadyFrontmostAndQuietAnswersWithoutWaiting() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([app])
    let started = ContinuousClock.now
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 0, timeoutMs: 5000, bundleId: "a.b", resolvePid: script.resolver)
    }
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertLessThan(ContinuousClock.now - started, .seconds(2))
    await monitor.stop()
  }

  func testNeverBecomingFrontmostEndsWithAMismatchReasonAtTheDeadline() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 0, timeoutMs: 600, bundleId: "a.b", resolvePid: script.resolver)
    }
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: springboard))
    await reader.waitOpened(2)
    reader.emit(.state(.quiet, pid: springboard))
    let outcome = try await wait.value
    XCTAssertFalse(outcome.quiet)
    XCTAssertEqual(outcome.reason, "frontmost_mismatch")
    XCTAssertEqual(outcome.frontmostPid, springboard)
    await monitor.stop()
  }

  func testAStreamLatchedOnTheOldAppIsRestartedOnce() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    let script = PidScript([app])
    let wait = Task {
      try await monitor.waitQuiet(quietMs: 0, timeoutMs: 3000, bundleId: "a.b", resolvePid: script.resolver)
    }
    await reader.waitOpened()
    reader.emit(.state(.quiet, pid: springboard))
    await reader.waitOpened(2)
    reader.emit(.state(.quiet, pid: app))
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet, "a fresh stream resolved the new frontmost app")
    XCTAssertEqual(reader.opened, 2)
    await monitor.stop()
  }
}
