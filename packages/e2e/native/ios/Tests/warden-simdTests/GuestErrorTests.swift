import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import XCTest

@testable import warden_simd

/// `GuestError` is what ops, the fallback and stall policy and the wire mapping see of a backend failure. These tests
/// need no backend: they build the cases directly, so a second backend only has to produce the same values.
final class GuestErrorTests: XCTestCase {
  func testTheMessageIsTheErrorDescription() {
    let error = GuestError.timeout(message: "did not answer")
    XCTAssertEqual(error.localizedDescription, "did not answer")
    XCTAssertEqual(error.message, "did not answer")
  }

  // MARK: wire

  func testAppErrorsNameThePidAndBundle() {
    let gone = GuestError.appUnavailable(pid: 42, bundleID: "a.b", message: "gone").wire
    XCTAssertEqual(gone.code, .appUnavailable)
    XCTAssertEqual(gone.detail?["pid"], 42)
    XCTAssertEqual(gone.detail?["bundleId"], "a.b")
    let silent = GuestError.appNotResponding(pid: nil, bundleID: nil, message: "busy").wire
    XCTAssertEqual(silent.code, .appNotResponding)
    XCTAssertTrue(silent.retryable)
    XCTAssertNil(silent.detail)
  }

  func testGuestSilenceIsATimeoutWithTheWaitedSeconds() {
    let wire = GuestError.guestNotAnswering(afterSeconds: 10, message: "silent").wire
    XCTAssertEqual(wire.code, .timeout)
    XCTAssertEqual(wire.detail?["afterSeconds"], .double(10))
  }

  func testBridgeAndFrontmostFailuresAreAxUnavailable() {
    XCTAssertEqual(GuestError.bridgeUnavailable(message: "x").wire.code, .axUnavailable)
    XCTAssertEqual(GuestError.frontmostUnresolved(message: "x").wire.code, .axUnavailable)
    XCTAssertEqual(GuestError.axUnavailable(message: "x").wire.code, .axUnavailable)
  }

  func testHostSilenceCarriesTheRequestAndTheWait() {
    let wire = GuestError.hostSilent(
      request: "frontmost", elapsedMs: 5000, behindAbandoned: 2, frontmost: true, message: "no answer"
    ).wire
    XCTAssertEqual(wire.code, .timeout)
    XCTAssertEqual(wire.detail?["stage"], "ax")
    XCTAssertEqual(wire.detail?["axError"], "no answer")
    XCTAssertEqual(wire.detail?["request"], "frontmost")
    XCTAssertEqual(wire.detail?["elapsedMs"], 5000)
    XCTAssertEqual(wire.detail?["behindAbandoned"], 2)
    XCTAssertEqual(wire.detail?["reason"], "frontmost_unresolved")
    let other = GuestError.hostSilent(
      request: "query", elapsedMs: 100, behindAbandoned: 0, frontmost: false, message: "x"
    ).wire
    XCTAssertNil(other.detail?["behindAbandoned"])
    XCTAssertNil(other.detail?["reason"])
  }

  func testHostUnavailableIsAxUnavailableAndNamesAMissingFrontmost() {
    let missing = GuestError.hostUnavailable(frontmostMissing: true, message: "no app").wire
    XCTAssertEqual(missing.code, .axUnavailable)
    XCTAssertEqual(missing.detail?["reason"], "frontmost_unresolved")
    XCTAssertNil(GuestError.hostUnavailable(frontmostMissing: false, message: "x").wire.detail?["reason"])
  }

  func testHostFailuresKeepTheirCodes() {
    XCTAssertEqual(GuestError.hostNotBooted(message: "x").wire.code, .notBooted)
    XCTAssertEqual(GuestError.hostNoElement(message: "x").wire.code, .noElement)
    let other = GuestError.hostFailure(message: "x").wire
    XCTAssertEqual(other.code, .internal)
    XCTAssertEqual(other.detail?["stage"], "ax")
  }

  func testNothingThereIsNoElementAndAMovedElementIsRetryable() {
    XCTAssertEqual(GuestError.noElementAtPoint(message: "x").wire.code, .noElement)
    XCTAssertFalse(GuestError.noElement(message: "x", retryable: false).wire.retryable)
    XCTAssertTrue(GuestError.noElement(message: "x", retryable: true).wire.retryable)
  }

  func testRequestShapedFailures() {
    XCTAssertEqual(GuestError.timeout(message: "x").wire.code, .timeout)
    XCTAssertEqual(GuestError.invalidRequest(message: "x").wire.code, .badRequest)
    XCTAssertEqual(GuestError.unsupported(message: "x").wire.code, .unsupported)
    XCTAssertEqual(GuestError.hid(message: "x").wire.detail?["kind"], "SimulatorHIDError")
    XCTAssertEqual(GuestError.hid(message: "x").wire.code, .hid)
    XCTAssertEqual(GuestError.io(message: "x").wire.code, .io)
    XCTAssertEqual(GuestError.failed(message: "x").wire.code, .internal)
  }

  func testLaunchFailuresNameTheBundle() {
    let missing = GuestError.appNotInstalled(bundleID: "a.b", message: "x").wire
    XCTAssertEqual(missing.code, .appUnavailable)
    XCTAssertEqual(missing.detail?["bundleId"], "a.b")
    let running = GuestError.appAlreadyRunning(bundleID: "a.b", pid: 7, message: "x").wire
    XCTAssertEqual(running.code, .internal)
    XCTAssertEqual(running.detail?["pid"], 7)
    XCTAssertEqual(GuestError.targetExited(pid: 9, message: "x").wire.detail?["pid"], 9)
    let none = GuestError.noRunningProcess(message: "x").wire
    XCTAssertEqual(none.code, .appUnavailable)
    XCTAssertNil(none.detail)
  }

  func testADisplayStillChangingIsRetryable() {
    let wire = GuestError.displayChanging(message: "x").wire
    XCTAssertEqual(wire.code, .internal)
    XCTAssertTrue(wire.retryable)
    XCTAssertEqual(wire.detail?["reason"], "display_changing")
  }

  func testWireErrorFromTakesAGuestErrorOrAnythingElse() {
    XCTAssertEqual(WireError.from(GuestError.timeout(message: "t")), WireError(.timeout, "t"))
    let both = AXReadersFailed(bridgeReason: "stalled", host: GuestError.hostFailure(message: "host said no"))
    let wire = WireError.from(both)
    XCTAssertEqual(wire.code, .internal)
    XCTAssertEqual(wire.detail?["bridgeError"], "stalled")
    XCTAssertEqual(wire.detail?["axError"], "host said no")
  }

  // MARK: classification

  func testBridgeFailuresAreTheOnesTheHostReaderMayStillAnswer() {
    let failures: [GuestError] = [
      .bridgeUnavailable(message: ""), .frontmostUnresolved(message: ""),
      .appUnavailable(pid: 1, bundleID: nil, message: ""), .appNotResponding(pid: 1, bundleID: nil, message: ""),
      .guestNotAnswering(afterSeconds: 1, message: ""),
    ]
    for failure in failures { XCTAssertTrue(Session.isBridgeFailure(failure), "\(failure)") }
    let others: [GuestError] = [
      .axUnavailable(message: ""), .noElement(message: "", retryable: false), .timeout(message: ""),
      .hostSilent(request: nil, elapsedMs: 0, behindAbandoned: 0, frontmost: false, message: ""),
      .targetExited(pid: 1, message: ""),
    ]
    for other in others { XCTAssertFalse(Session.isBridgeFailure(other), "\(other)") }
    XCTAssertTrue(Session.isBridgeFailure(BridgeStalled(afterMs: 4000)))
    XCTAssertFalse(Session.isBridgeFailure(CancellationError()))
  }

  func testNotRespondingNamesItsPid() {
    let error = GuestError.appNotResponding(pid: 33, bundleID: nil, message: "")
    XCTAssertTrue(Session.isNotResponding(error))
    XCTAssertEqual(Session.notRespondingPid(error), 33)
    XCTAssertFalse(Session.isNotResponding(GuestError.appUnavailable(pid: 33, bundleID: nil, message: "")))
    XCTAssertNil(Session.notRespondingPid(GuestError.timeout(message: "")))
  }

  func testSilenceIsToldApartByWhoWasSilent() {
    XCTAssertTrue(Session.isGuestSilent(GuestError.guestNotAnswering(afterSeconds: 1, message: "")))
    XCTAssertFalse(Session.isGuestSilent(GuestError.timeout(message: "")))
    let host = GuestError.hostSilent(request: nil, elapsedMs: 1, behindAbandoned: 0, frontmost: false, message: "")
    XCTAssertTrue(AXWedgeRecovery.isServiceSilent(host))
    XCTAssertFalse(AXWedgeRecovery.isServiceSilent(GuestError.hostFailure(message: "")))
  }

  func testAFrontmostThatCouldNotBeNamedIsToldApartFromAGoneApp() {
    XCTAssertTrue(Session.isFrontmostUnresolved(GuestError.frontmostUnresolved(message: "")))
    XCTAssertTrue(
      Session.isFrontmostUnresolved(
        GuestError.hostSilent(request: "frontmost", elapsedMs: 0, behindAbandoned: 0, frontmost: true, message: "")))
    XCTAssertTrue(Session.isFrontmostUnresolved(GuestError.hostUnavailable(frontmostMissing: true, message: "")))
    XCTAssertFalse(Session.isFrontmostUnresolved(GuestError.hostUnavailable(frontmostMissing: false, message: "")))
    XCTAssertFalse(Session.isFrontmostUnresolved(GuestError.appUnavailable(pid: 1, bundleID: nil, message: "")))
    XCTAssertTrue(
      Session.isFrontmostUnresolved(
        AXReadersFailed(bridgeReason: "", host: GuestError.frontmostUnresolved(message: ""))))
  }
}

/// The adapter is the only place idb's errors become `GuestError`s, and it is the only place that does it.
final class IdbErrorSeamTests: XCTestCase {
  func testAGuestErrorAndAnythingForeignPassThrough() {
    let guest = GuestError.timeout(message: "x")
    XCTAssertEqual(IdbErrors.map(guest) as? GuestError, guest)
    XCTAssertTrue(IdbErrors.map(CancellationError()) is CancellationError)
    XCTAssertEqual((IdbErrors.map(CocoaError(.fileNoSuchFile)) as? CocoaError)?.code, .fileNoSuchFile)
  }

  func testIdbErrorsBecomeGuestErrorsWithTheirOwnMessage() {
    let bridge = AXBridgeError.guestNotAnswering(after: 10)
    XCTAssertEqual(
      IdbErrors.map(bridge) as? GuestError, .guestNotAnswering(afterSeconds: 10, message: bridge.localizedDescription))
    let display = SimulatorDisplayError.changed
    XCTAssertEqual(IdbErrors.map(display) as? GuestError, .displayChanging(message: display.localizedDescription))
    XCTAssertEqual(
      IdbErrors.map(UIAutomationError.noElementAtPoint(backend: .accessibility, x: 1, y: 2)) as? GuestError,
      .noElementAtPoint(
        message: UIAutomationError.noElementAtPoint(backend: .accessibility, x: 1, y: 2).localizedDescription))
  }

  func testTheMappingWrapperTurnsAThrownIdbErrorIntoAGuestError() async {
    do {
      _ = try await IdbErrors.mapping { () async throws -> Int in throw AXBridgeError.bridgeUnavailable }
      XCTFail("expected a throw")
    } catch {
      XCTAssertTrue(error is GuestError, "\(error)")
    }
  }

  func testANodeKeepsAReportedTraitsFieldEvenWhenEmpty() {
    var idbNode = AccessibilityDocumentElement()
    idbNode.traits = .some(nil)
    XCTAssertTrue(IdbAXReader.node(idbNode).traitsReported)
    XCTAssertNil(IdbAXReader.node(idbNode).traits)
    XCTAssertFalse(IdbAXReader.node(AccessibilityDocumentElement()).traitsReported)
  }

  func testSignalsAndOrientationsMapOneToOneWithTheirWireSpelling() {
    XCTAssertEqual(AXQuiescenceSignal.allCases.count, QuiescenceSignal.allCases.count)
    for signal in QuiescenceSignal.allCases {
      XCTAssertEqual(IdbAXReader.signal(signal)?.rawValue, signal.rawValue)
    }
    XCTAssertEqual(DeviceOrientation.allCases.count, SimulatorDeviceOrientation.allCases.count)
    for orientation in SimulatorDeviceOrientation.allCases {
      XCTAssertEqual(IdbOrientation.orientation(orientation).rawValue, orientation.rawValue)
    }
  }

  func testFrontmostMethodsKeepTheirWireSpelling() {
    for method in FrontmostMethod.allCases {
      XCTAssertEqual(method.rawValue, method.idb.rawValue, "\(method)")
    }
    XCTAssertEqual(FrontmostMethod.allCases.count, AXBridgeFrontmostMethod.allCases.count)
  }

  func testTheRequestedKeysAreTheReaderKeys() {
    XCTAssertEqual(AXKey.requested(["label", "traits"]), Set(AXKeys.requested(["label", "traits"]).compactMap(AXKey.init)))
    XCTAssertTrue(AXKey.requested(["traits"]).contains(.traits))
    XCTAssertEqual(AXKey.allCases.count, AXKeys.allCases.count)
    for key in AXKey.allCases { XCTAssertEqual(AXKey(key.idb), key, "\(key)") }
    for key in AXKeys.allCases { XCTAssertEqual(AXKey(key)?.idb, key, "\(key)") }
  }
}
