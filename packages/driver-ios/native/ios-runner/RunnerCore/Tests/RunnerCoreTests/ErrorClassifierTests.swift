import XCTest

@testable import RunnerCore

final class ErrorClassifierTests: XCTestCase {
  func testMissingKeyboardFocusIsNoElement() {
    let error = ErrorClassifier.classify(
      op: "typeText", messages: ["Neither element nor any descendant has keyboard focus. Element: Application"])
    XCTAssertEqual(error.code, .noElement)
    XCTAssertFalse(error.retryable)
    XCTAssertEqual(error.detail?["issues"]?.arrayValue?.count, 1)
  }

  func testTimeoutsAreRetryableAppNotResponding() {
    let error = ErrorClassifier.classify(op: "tap", messages: ["Timed out while waiting for the app to idle"])
    XCTAssertEqual(error.code, .appNotResponding)
    XCTAssertTrue(error.retryable)
  }

  func testTerminatedAppIsAppUnavailable() {
    XCTAssertEqual(
      ErrorClassifier.classify(op: "snapshot", messages: ["Application com.example is not running"]).code, .appUnavailable)
  }

  func testUnknownInputFailureIsHidAndOtherwiseInternal() {
    XCTAssertEqual(ErrorClassifier.classify(op: "swipe", messages: ["something odd"]).code, .hid)
    XCTAssertEqual(ErrorClassifier.classify(op: "screenshot", messages: ["something odd"]).code, .internal)
  }

  func testIssuesAreJoinedIntoTheMessage() {
    let error = ErrorClassifier.classify(op: "tap", messages: ["a", "b"])
    XCTAssertEqual(error.message, "tap: a; b")
  }

  func testThrownWireErrorPassesThrough() {
    let thrown = WireError(.timeout, "slow")
    XCTAssertEqual(ErrorClassifier.classify(op: "snapshot", error: thrown), thrown)
  }
}
