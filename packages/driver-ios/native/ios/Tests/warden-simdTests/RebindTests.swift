import FBSimulatorAX
import Foundation
import XCTest

@testable import warden_simd

/// A resolver whose `blockOnCall`-th call suspends until the test releases it (a launchd lookup that takes long
/// enough for the stream to move on in the meantime).
private final class BlockingResolver: @unchecked Sendable {
  private let lock = NSLock()
  private let pid: pid_t?
  private let blockOnCall: Int
  private var calls = 0
  private var parked: CheckedContinuation<Void, Never>?
  private var released = false

  init(pid: pid_t?, blockOnCall: Int) {
    self.pid = pid
    self.blockOnCall = blockOnCall
  }

  var isParked: Bool { lock.withLock { parked != nil } }

  func release() {
    let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
      released = true
      defer { parked = nil }
      return parked
    }
    waiting?.resume()
  }

  var resolver: PidResolver {
    { [self] _ in
      let shouldBlock = lock.withLock { () -> Bool in
        calls += 1
        return calls == blockOnCall
      }
      if shouldBlock {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
          let alreadyReleased = lock.withLock { () -> Bool in
            if released { return true }
            parked = continuation
            return false
          }
          if alreadyReleased { continuation.resume() }
        }
      }
      return pid
    }
  }
}

/// Hands out pids from a script, one per call; the last entry repeats.
private final class PidSequence: @unchecked Sendable {
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

/// The relaunch path: `restart` never leaves two streams, a stream that follows a relaunched app by itself is left
/// alone, and `bind` (the helper's `rebind` op) returns once the stream reports on the app's own process.
/// A resolver that always answers `pid`.
private func fixed(_ pid: pid_t?) -> PidResolver { { _ in pid } }

final class RebindTests: XCTestCase {
  private let springboard: pid_t = 100
  private let app: pid_t = 200

  /// Polls `condition` until it holds, failing (rather than hanging) after `timeoutMs`.
  private func eventually(_ message: String, timeoutMs: Int = 5000, _ condition: () -> Bool) async {
    let deadline = ContinuousClock.now + .milliseconds(timeoutMs)
    while !condition() {
      if ContinuousClock.now >= deadline { return XCTFail(message) }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  // MARK: restart ordering

  /// The old stream's task may still be inside its open call when a restart arrives (a loaded machine: seconds).
  /// The next stream must not be requested before that task is gone: two guests on one simulator stall each other.
  func testRestartWaitsForTheOldStreamBeforeRequestingTheNextOne() async {
    let reader = FakeReader()
    reader.holdOpens = true
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await eventually("the first open was never requested") { reader.requests == 1 }
    let restart = Task { await monitor.restart() }
    try? await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(reader.requests, 1, "a second stream was requested while the first was still being torn down")
    reader.releaseOpens()
    await restart.value
    await reader.waitOpened(1)
    XCTAssertEqual(reader.requests, 2)
    XCTAssertEqual(reader.opened, 1, "the cancelled open must not produce a live stream")
    await monitor.stop()
  }

  func testTwoRestartsAtOnceLeaveExactlyOneReplacementStream() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    async let first: Void = monitor.restart()
    async let second: Void = monitor.restart()
    _ = await (first, second)
    await reader.waitOpened(2)
    try? await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(reader.requests, 2, "concurrent restarts opened more than one replacement stream")
    await monitor.stop()
  }

  // MARK: bind

  func testBindLeavesAStreamThatFollowsTheRelaunchedAppAlone() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    let app = self.app
    let binding = Task { await monitor.bind(bundleId: "a.b", timeoutMs: 5000, resolvePid: fixed(app)) }
    try? await Task.sleep(for: .milliseconds(200))
    reader.emit(.targetChanged(pid: app))
    reader.emit(.state(.settling, pid: app))
    let outcome = await binding.value
    XCTAssertTrue(outcome.bound)
    XCTAssertEqual(outcome.pid, app)
    XCTAssertEqual(outcome.restarts, 0)
    XCTAssertEqual(reader.requests, 1, "a stream that follows by itself was restarted")
    await monitor.stop()
  }

  func testBindWaitsForAStateNotJustForTheTargetToChange() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    let began = ContinuousClock.now
    let app = self.app
    let binding = Task { await monitor.bind(bundleId: "a.b", timeoutMs: 5000, resolvePid: fixed(app)) }
    try? await Task.sleep(for: .milliseconds(100))
    reader.emit(.targetChanged(pid: app))
    try? await Task.sleep(for: .milliseconds(300))
    reader.emit(.state(.busy([.runLoopIdle]), pid: app))
    let outcome = await binding.value
    XCTAssertTrue(outcome.bound)
    XCTAssertGreaterThanOrEqual(ContinuousClock.now - began, .milliseconds(350), "returned before the stream reported")
    await monitor.stop()
  }

  func testBindReturnsAtOnceWhenTheStreamAlreadyReportsOnTheApp() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: app))
    try? await Task.sleep(for: .milliseconds(50))
    let began = ContinuousClock.now
    let outcome = await monitor.bind(bundleId: "a.b", timeoutMs: 5000, resolvePid: fixed(app))
    XCTAssertTrue(outcome.bound)
    XCTAssertLessThan(ContinuousClock.now - began, .seconds(1))
    XCTAssertEqual(reader.requests, 1)
    await monitor.stop()
  }

  /// A stream still reporting the old app once the grace has passed is latched: it is restarted, and the fresh
  /// stream's first state for the app ends the bind.
  func testBindRestartsAStreamThatNeverFollows() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    let app = self.app
    let binding = Task { await monitor.bind(bundleId: "a.b", timeoutMs: 8000, resolvePid: fixed(app)) }
    await reader.waitOpened(2)
    reader.emit(.state(.quiet, pid: app))
    let outcome = await binding.value
    XCTAssertTrue(outcome.bound)
    XCTAssertEqual(outcome.restarts, 1)
    XCTAssertEqual(reader.requests, 2)
    await monitor.stop()
  }

  func testBindWaitsForTheProcessToExist() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    let script = PidSequence([nil, nil, nil, app])
    let binding = Task { await monitor.bind(bundleId: "a.b", timeoutMs: 5000, resolvePid: script.resolver) }
    try? await Task.sleep(for: .milliseconds(100))
    reader.emit(.targetChanged(pid: app))
    reader.emit(.state(.quiet, pid: app))
    let outcome = await binding.value
    XCTAssertTrue(outcome.bound)
    XCTAssertGreaterThanOrEqual(script.calls, 4)
    await monitor.stop()
  }

  func testBindGivesUpAtTheDeadlineWithoutThrowing() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    let began = ContinuousClock.now
    let outcome = await monitor.bind(bundleId: "a.b", timeoutMs: 300, resolvePid: fixed(nil))
    XCTAssertFalse(outcome.bound)
    XCTAssertEqual(outcome.reason, "no_process")
    XCTAssertGreaterThanOrEqual(ContinuousClock.now - began, .milliseconds(280))
    XCTAssertLessThan(ContinuousClock.now - began, .seconds(3))
    await monitor.stop()
  }

  func testBindReportsATimeoutWhenTheStreamStaysOnAnotherProcess() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    let outcome = await monitor.bind(bundleId: "a.b", timeoutMs: 300, resolvePid: fixed(app))
    XCTAssertFalse(outcome.bound)
    XCTAssertEqual(outcome.reason, "timeout")
    XCTAssertEqual(outcome.pid, springboard)
    await monitor.stop()
  }

  // MARK: settle

  /// The pid lookup is a launchd round trip (150-350 ms on a loaded host): the stream can follow the app while it
  /// is in flight. The decision to restart must use what the stream says after the lookup, not before it.
  func testSettleDoesNotRestartAStreamThatFollowedWhileThePidWasBeingResolved() async throws {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    // the grace and the lookup interval coincide: the first loop turn that is past the grace is the one whose
    // lookup (the second call) parks
    let timing = FrontmostGate.Timing(resolveEveryMs: 100, firstRestartGraceMs: 100, repeatRestartMs: 1500)
    let blocking = BlockingResolver(pid: app, blockOnCall: 2)
    let wait = Task {
      try await monitor.waitQuiet(
        quietMs: 0, timeoutMs: 8000, bundleId: "a.b", resolvePid: blocking.resolver, gateTiming: timing)
    }
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    await eventually("the resolver never parked") { blocking.isParked }
    reader.emit(.targetChanged(pid: app))
    reader.emit(.state(.quiet, pid: app))
    try await Task.sleep(for: .milliseconds(100))
    blocking.release()
    let outcome = try await wait.value
    XCTAssertTrue(outcome.quiet)
    XCTAssertEqual(reader.requests, 1, "the stream had followed the app; restarting it threw that away")
    await monitor.stop()
  }

  // MARK: recover

  func testRecoverWaitsForTheStreamToFollowTheNamedProcessBeforeRestarting() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    let app = self.app
    let recovery = Task { await monitor.recover(pid: app, timeoutMs: 5000) }
    try? await Task.sleep(for: .milliseconds(150))
    reader.emit(.targetChanged(pid: app))
    reader.emit(.state(.settling, pid: app))
    await recovery.value
    XCTAssertEqual(reader.requests, 1, "the stream followed the app; a restart was not needed")
    await monitor.stop()
  }

  func testRecoverRestartsWhenTheStreamDoesNotFollowTheNamedProcess() async {
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    reader.emit(.state(.quiet, pid: springboard))
    let app = self.app
    let recovery = Task { await monitor.recover(pid: app, timeoutMs: 8000) }
    await reader.waitOpened(2)
    reader.emit(.state(.quiet, pid: app))
    await recovery.value
    XCTAssertEqual(reader.requests, 2)
    await monitor.stop()
  }

  // MARK: request

  func testRebindRequestNeedsABundleIdAndHasABudget() throws {
    let request = try RebindRequest(["bundleId": "a.b"])
    XCTAssertEqual(request.bundleId, "a.b")
    XCTAssertEqual(request.timeoutMs, RebindRequest.defaultTimeoutMs)
    XCTAssertEqual(try RebindRequest(["bundleId": "a.b", "timeoutMs": 900]).timeoutMs, 900)
    XCTAssertEqual(
      try RebindRequest(["bundleId": "a.b", "timeoutMs": 900, "rebindTimeoutMs": 1500]).timeoutMs, 1500,
      "the op's own budget wins over the envelope timeout the client pads")
    for bad: JSON in [.null, .string(""), .int(3)] {
      XCTAssertThrowsError(try RebindRequest(["bundleId": bad])) { error in
        XCTAssertEqual((error as? WireError)?.code, .badRequest)
      }
    }
    XCTAssertThrowsError(try RebindRequest([:]))
    XCTAssertThrowsError(try RebindRequest(["bundleId": "a.b", "rebindTimeoutMs": -1]))
  }

  func testRebindIsSelfTimed() {
    XCTAssertTrue(Dispatcher<Session>.selfTimedOps.contains("rebind"))
    XCTAssertNotNil(Dispatcher<Session>.standard().handlers["rebind"])
  }
}
