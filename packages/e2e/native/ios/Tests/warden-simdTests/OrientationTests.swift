import FBSimulatorControl
import XCTest

@testable import warden_simd

private final class Steps: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String] = []
  func add(_ step: String) { lock.withLock { items.append(step) } }
  var all: [String] { lock.withLock { items } }
}

/// Setting the orientation: write, wait for the device to read it back, then wait for the screen to stop moving. A
/// touch sent while the rotation animates is dropped even at the right point, so the op answers only after it.
final class OrientationTests: XCTestCase {
  func testRotateWritesReadsBackThenSettles() async throws {
    let steps = Steps()
    var reads = [SimulatorDeviceOrientation.portrait, .landscapeLeft]
    let settled = try await Session.rotate(
      to: .landscapeLeft,
      write: { steps.add("write") },
      read: {
        steps.add("read")
        return reads.isEmpty ? .landscapeLeft : reads.removeFirst()
      },
      settle: {
        steps.add("settle")
        return true
      },
      poll: .milliseconds(1))
    XCTAssertEqual(settled, true)
    XCTAssertEqual(steps.all, ["write", "read", "read", "settle"])
  }

  func testAQuietTimeoutStillAnswers() async throws {
    let settled = try await Session.rotate(
      to: .landscapeRight, write: {}, read: { .landscapeRight }, settle: { false }, poll: .milliseconds(1))
    XCTAssertEqual(settled, false)
  }

  /// No bridge, no stream: the rotation is still done, `settled` is just unknown.
  func testNoSettleAvailableIsUnknown() async throws {
    let settled = try await Session.rotate(
      to: .portrait, write: {}, read: { .portrait }, settle: { nil }, poll: .milliseconds(1))
    XCTAssertNil(settled)
  }

  /// A runtime that cannot read orientation back still settles once the read gives up.
  func testAnUnreadableDeviceStillSettles() async throws {
    let steps = Steps()
    let settled = try await Session.rotate(
      to: .landscapeLeft, write: {}, read: { nil },
      settle: {
        steps.add("settle")
        return true
      }, poll: .milliseconds(1))
    XCTAssertEqual(settled, true)
    XCTAssertEqual(steps.all, ["settle"])
  }

  func testAFailedWriteNeverSettles() async {
    let steps = Steps()
    struct Refused: Error {}
    do {
      _ = try await Session.rotate(
        to: .landscapeLeft, write: { throw Refused() }, read: { .landscapeLeft },
        settle: {
          steps.add("settle")
          return true
        }, poll: .milliseconds(1))
      XCTFail("expected the write to throw")
    } catch {
      XCTAssertTrue(error is Refused)
    }
    XCTAssertEqual(steps.all, [])
  }

  /// A device that reads the new orientation back at once (seen in a spec run: the op answered in 317 ms and the
  /// next tap was dropped) still waits out the start of the rotation before the settle.
  func testAnInstantReadBackStillWaitsTheMinimum() async throws {
    let started = ContinuousClock.now
    var settledAt: ContinuousClock.Instant?
    _ = try await Session.rotate(
      to: .landscapeRight, write: {}, read: { .landscapeRight },
      settle: {
        settledAt = ContinuousClock.now
        return true
      }, minimumBeforeSettle: .milliseconds(80), poll: .milliseconds(1))
    let waited = try XCTUnwrap(settledAt) - started
    XCTAssertGreaterThanOrEqual(waited, .milliseconds(80))
  }

  /// The minimum counts from the write, so a read-back that already outlasted it settles at once. Measured as the gap
  /// between the last read and the settle (no sleep on the right path), never as a sum of sleeps: a loaded runner
  /// oversleeps every poll, and a total-time budget fails there with nothing wrong.
  func testASlowReadBackAddsNoExtraWait() async throws {
    let minimum: Duration = .milliseconds(200)
    var reads = 0
    var lastReadAt: ContinuousClock.Instant?
    var settledAt: ContinuousClock.Instant?
    _ = try await Session.rotate(
      to: .landscapeLeft, write: {},
      read: {
        reads += 1
        lastReadAt = ContinuousClock.now
        return reads < 6 ? .portrait : .landscapeLeft
      },
      settle: {
        settledAt = ContinuousClock.now
        return true
      }, minimumBeforeSettle: minimum, poll: .milliseconds(50))
    let gap = try XCTUnwrap(settledAt) - XCTUnwrap(lastReadAt)
    XCTAssertLessThan(gap, minimum, "the minimum was waited again after the read-back")
  }

  func testTheSettleWindow() {
    XCTAssertEqual(Session.rotationMinimumBeforeSettle, .milliseconds(400))
    XCTAssertEqual(Session.rotationSettle.quietMs, 300)
    XCTAssertEqual(Session.rotationSettle.timeoutMs, 3000)
  }
}
