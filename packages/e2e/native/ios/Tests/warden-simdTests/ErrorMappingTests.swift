import FBSimulatorAX
import FBSimulatorControl
import XCTest

@testable import warden_simd

final class ErrorMappingTests: XCTestCase {
  func testCodeListMatchesTheProtocol() {
    XCTAssertEqual(
      Set(ErrorCode.allCases.map(\.rawValue)),
      [
        "E_BAD_REQUEST", "E_TIMEOUT", "E_NOT_BOOTED", "E_UNKNOWN_UDID", "E_HID", "E_AX_UNAVAILABLE",
        "E_APP_UNAVAILABLE", "E_APP_NOT_RESPONDING", "E_NO_ELEMENT", "E_UNSUPPORTED", "E_UNSUPPORTED_TEXT", "E_IO",
        "E_INTERNAL",
      ])
  }

  func testRetryableDefaultsMirrorTheTSDriver() {
    XCTAssertTrue(WireError(.timeout, "").retryable)
    XCTAssertTrue(WireError(.axUnavailable, "").retryable)
    XCTAssertTrue(WireError(.appNotResponding, "").retryable)
    XCTAssertFalse(WireError(.badRequest, "").retryable)
    XCTAssertFalse(WireError(.hid, "").retryable)
    XCTAssertTrue(WireError(.badRequest, "", retryable: true).retryable)
  }

  func testWireErrorPassesThrough() {
    let original = WireError(.unsupportedText, "rest", detail: ["rest": "é"])
    XCTAssertEqual(WireError.from(original), original)
  }

  func testCancellationAndUnknownErrorsAreInternal() {
    XCTAssertEqual(WireError.from(CancellationError()).code, .internal)
    struct Boom: Error {}
    XCTAssertEqual(WireError.from(Boom()).code, .internal)
  }

  func testFileSystemErrorsAreIO() {
    XCTAssertEqual(WireError.from(CocoaError(.fileNoSuchFile)).code, .io)
    XCTAssertEqual(WireError.from(POSIXError(.ENOSPC)).code, .io)
  }

  func testBridgeErrors() {
    XCTAssertEqual(WireError.from(AXBridgeError.bridgeUnavailable).code, .axUnavailable)
    XCTAssertEqual(WireError.from(AXBridgeError.readerUnavailable("x")).code, .axUnavailable)
    XCTAssertEqual(WireError.from(AXBridgeError.guestFailure("x")).code, .axUnavailable)
    let unavailable = WireError.from(AXBridgeError.applicationUnavailable(pid: 42))
    XCTAssertEqual(unavailable.code, .appUnavailable)
    XCTAssertEqual(unavailable.detail?["pid"], 42)
    XCTAssertEqual(WireError.from(AXBridgeError.applicationNotResponding(pid: nil)).code, .appNotResponding)
    XCTAssertTrue(WireError.from(AXBridgeError.applicationNotResponding(pid: nil)).retryable)
    XCTAssertEqual(WireError.from(AXBridgeError.assertionFailed("x")).code, .noElement)
  }

  func testUIAutomationErrors() {
    let backend = UIAutomationBackend.accessibility
    XCTAssertEqual(
      WireError.from(UIAutomationError.elementNotFound(backend: backend, key: "label", value: "x")).code, .noElement)
    XCTAssertEqual(WireError.from(UIAutomationError.noElementAtPoint(backend: backend, x: 1, y: 2)).code, .noElement)
    XCTAssertEqual(
      WireError.from(UIAutomationError.timedOut(backend: backend, key: "label", value: "x", timeout: 1)).code, .timeout)
    XCTAssertEqual(
      WireError.from(UIAutomationError.operationUnsupported(backend: backend, operation: "pinch")).code, .unsupported)
    XCTAssertEqual(
      WireError.from(UIAutomationError.markerRequired(backend: backend, operation: "wait")).code, .badRequest)
    let app = WireError.from(UIAutomationError.applicationUnavailable(backend: backend, pid: 7, bundleID: "a.b"))
    XCTAssertEqual(app.code, .appUnavailable)
    XCTAssertEqual(app.detail?["bundleId"], "a.b")
    XCTAssertEqual(
      WireError.from(UIAutomationError.applicationNotResponding(backend: backend, pid: 7)).code, .appNotResponding)
  }

  func testHIDErrorsAreE_HID() {
    XCTAssertEqual(WireError.from(SimulatorHIDError.clientDisposed).code, .hid)
    XCTAssertEqual(WireError.from(SimulatorHIDError.legacyInputSuppressed(operation: "Touch")).code, .hid)
  }

  func testNegotiatedTransportFollowsCoreSimulatorVersion() {
    XCTAssertEqual(Session.negotiatedTransport(coreSimulatorVersion: nil), "indigo")
    XCTAssertEqual(Session.negotiatedTransport(coreSimulatorVersion: "1051.17"), "indigo")
    XCTAssertEqual(Session.negotiatedTransport(coreSimulatorVersion: "1155.3"), "indigo")
    XCTAssertEqual(Session.negotiatedTransport(coreSimulatorVersion: "1155.4"), "dtuhid")
    XCTAssertEqual(Session.negotiatedTransport(coreSimulatorVersion: "1155.10"), "dtuhid")
    XCTAssertEqual(Session.negotiatedTransport(coreSimulatorVersion: "1200.1"), "dtuhid")
  }
}
