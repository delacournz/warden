import CoreGraphics
import FBSimulatorAX
import Foundation
import XCTest

@testable import warden_simd

/// A quiescence source the test drives by hand: `emit` pushes events into the stream the monitor last opened.
private final class FakeReader: UIAutomation, @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: AsyncThrowingStream<QuiescenceEvent, Error>.Continuation?
  private(set) var opened = 0

  func quiescence(
    _ query: AccessibilityElementQuery, parameters: QuiescenceParameters
  ) async throws -> AsyncThrowingStream<QuiescenceEvent, Error> {
    let (stream, continuation) = AsyncThrowingStream<QuiescenceEvent, Error>.makeStream()
    lock.withLock {
      self.continuation?.finish()
      self.continuation = continuation
      opened += 1
    }
    return stream
  }

  func emit(_ event: QuiescenceEvent) {
    lock.withLock { continuation }?.yield(event)
  }

  func waitOpened(_ count: Int = 1) async {
    while lock.withLock({ opened }) < count { try? await Task.sleep(for: .milliseconds(5)) }
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

  // MARK: waitQuiet

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
