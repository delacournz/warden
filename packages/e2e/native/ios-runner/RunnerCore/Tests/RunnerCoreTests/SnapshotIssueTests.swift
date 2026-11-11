import XCTest

@testable import RunnerCore

final class SnapshotIssueTests: XCTestCase {
  func testAccessibilitySnapshotWordingsAreTransient() {
    XCTAssertTrue(SnapshotIssue.isTransient("Failed to get matching snapshot: Error kAXErrorIllegalArgument getting snapshot"))
    XCTAssertTrue(SnapshotIssue.isTransient("Error kAXErrorServerNotFound performing accessibility query"))
    XCTAssertTrue(SnapshotIssue.isTransient("failed to get matching snapshot for Application"))
  }

  func testOtherIssuesAreNotTransient() {
    XCTAssertFalse(SnapshotIssue.isTransient("Neither element nor any descendant has keyboard focus"))
    XCTAssertFalse(SnapshotIssue.isTransient("Timed out while evaluating UI query."))
    XCTAssertFalse(SnapshotIssue.isTransient("Application com.example is not running"))
  }

  func testTransientErrorsByCodeOrWording() {
    XCTAssertTrue(SnapshotIssue.isTransient(error: WireError(.axUnavailable, "x")))
    XCTAssertTrue(SnapshotIssue.isTransient(error: NSError(domain: "kAXErrorDomain", code: -25204, userInfo: [
      NSLocalizedDescriptionKey: "Error kAXErrorCannotComplete getting snapshot",
    ])))
    XCTAssertFalse(SnapshotIssue.isTransient(error: WireError(.appUnavailable, "gone")))
  }

  func testClassifierAnswersRetryableAxUnavailableForSnapshotIssues() {
    let error = ErrorClassifier.classify(
      op: "snapshot", messages: ["Failed to get matching snapshot: Error kAXErrorIllegalArgument getting snapshot"])
    XCTAssertEqual(error.code, .axUnavailable)
    XCTAssertTrue(error.retryable)
  }

  // MARK: retry

  private struct Flaky: Error {}

  func testATransientFailureIsRetriedOnce() throws {
    var calls = 0
    var paused = 0
    let value = try SnapshotIssue.retryOnce(isTransient: { $0 is Flaky }, pause: { paused += 1 }) { () throws -> Int in
      calls += 1
      if calls == 1 { throw Flaky() }
      return 7
    }
    XCTAssertEqual(value, 7)
    XCTAssertEqual(calls, 2)
    XCTAssertEqual(paused, 1)
  }

  func testASecondTransientFailureIsThrown() {
    var calls = 0
    XCTAssertThrowsError(
      try SnapshotIssue.retryOnce(isTransient: { $0 is Flaky }, pause: {}) { () throws -> Int in
        calls += 1
        throw Flaky()
      }
    ) { XCTAssertTrue($0 is Flaky) }
    XCTAssertEqual(calls, 2)
  }

  func testANonTransientFailureIsNotRetried() {
    var calls = 0
    XCTAssertThrowsError(
      try SnapshotIssue.retryOnce(isTransient: { _ in false }, pause: {}) { () throws -> Int in
        calls += 1
        throw Flaky()
      })
    XCTAssertEqual(calls, 1)
  }
}
