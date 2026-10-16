import FBSimulatorAX
import FBSimulatorControl
import Foundation
import XCTest

@testable import warden_simd

/// AX documents captured from a booted simulator (iPhone 17, 402x874 @3x): the example app's sign-in screen over
/// axbridge, and a SpringBoard location-permission alert over both readers. The `*.golden.json` files are what the
/// helper produces for them; `native/scripts/element-shape.test.ts` validates the same files with the TS schemas.
final class SnapshotFixtureTests: XCTestCase {
  private let screen = DocumentFixture.screen

  /// `ms` is part of the wire shape; fixtures pin it to 0.
  private func payload(_ data: [String: JSON]) -> JSON {
    var data = data
    data["ms"] = .int(0)
    return .object(data)
  }

  private func snapshot(
    _ name: String, backend: AXBackend, interactiveOnly: Bool
  ) throws -> [String: JSON] {
    Session.renderSnapshot(
      document: try DocumentFixture.document(name), backend: backend, screen: screen, interactiveOnly: interactiveOnly)
  }

  // MARK: sign-in screen

  func testSignInFullSnapshotMatchesGolden() throws {
    let data = try snapshot("sign-in.document.json", backend: .axbridge, interactiveOnly: false)
    try DocumentFixture.assertGolden(payload(data), named: "sign-in.snapshot.golden.json")
    XCTAssertEqual(data["truncated"], .bool(false))
    XCTAssertNil(data["modal"])
  }

  func testSignInInteractiveSnapshotMatchesGolden() throws {
    let data = try snapshot("sign-in.document.json", backend: .axbridge, interactiveOnly: true)
    try DocumentFixture.assertGolden(payload(data), named: "sign-in.interactive.golden.json")
  }

  func testInteractiveSnapshotKeepsEveryTestIDOnTheScreen() throws {
    let document = try DocumentFixture.document("sign-in.document.json")
    let all = ElementBuilder.build(document.elements, options: Session.buildOptions(screen: screen, document: document.screen))
    let interactive = ElementBuilder.build(
      document.elements, options: Session.buildOptions(screen: screen, interactiveOnly: true, document: document.screen))
    let ids = Set(all.elements.flatMap(\.preorder).compactMap(\.identifier))
    let kept = Set(interactive.elements.flatMap(\.preorder).compactMap(\.identifier))
    XCTAssertEqual(kept, ids)
    for expected in ["sign-in-screen", "sign-in-email", "sign-in-password", "sign-in-submit", "sign-in-back"] {
      XCTAssertTrue(kept.contains(expected), expected)
    }
    XCTAssertLessThan(interactive.elements.flatMap(\.preorder).count, all.elements.flatMap(\.preorder).count)
  }

  func testSignInFieldsCarryRoleValueFrameAndTapPoint() throws {
    let document = try DocumentFixture.document("sign-in.document.json")
    let built = ElementBuilder.build(document.elements, options: Session.buildOptions(screen: screen, document: document.screen))
    let nodes = built.elements.flatMap(\.preorder)
    let email = try XCTUnwrap(nodes.first { $0.identifier == "sign-in-email" })
    XCTAssertEqual(email.role, .textfield)
    XCTAssertEqual(email.rawType, "TextField")
    XCTAssertEqual(email.frame, Rect(x: 21, y: 209, width: 360, height: 42))
    XCTAssertEqual(email.tapPoint, Point(x: 201, y: 230))
    let password = try XCTUnwrap(nodes.first { $0.identifier == "sign-in-password" })
    XCTAssertEqual(password.role, .securefield)
    XCTAssertTrue(password.traits.contains("secure-text-field"))
    let submit = try XCTUnwrap(nodes.first { $0.identifier == "sign-in-submit" })
    XCTAssertEqual(submit.role, .button)
    XCTAssertEqual(submit.label, "Sign in")
    XCTAssertEqual(submit.hittable, true)
  }

  // MARK: alerts

  func testHostReaderAlertPayloadMatchesGolden() throws {
    let document = try DocumentFixture.document("alert-host.document.json")
    let alert = try XCTUnwrap(Session.renderAlert(document: document, backend: .ax, screen: screen))
    try DocumentFixture.assertGolden(alert, named: "alert-host.alert.golden.json")
    XCTAssertEqual(alert["title"], .string("Allow “Maps” to use your location?"))
    XCTAssertNotNil(alert["message"]?.stringValue)
    XCTAssertEqual(
      alert["buttons"]?.arrayValue?.compactMap { $0["label"]?.stringValue },
      ["Allow Once", "Allow While Using App", "Don’t Allow"])
    let first = try XCTUnwrap(alert["buttons"]?.arrayValue?.first)
    XCTAssertEqual(first["tapPoint"]?["x"]?.doubleValue, 201)
    XCTAssertEqual(first["tapPoint"]?["y"]?.doubleValue, 482)
  }

  func testHostAlertShapeIsNotMistakenForAnAlertOnTheBridge() throws {
    let document = try DocumentFixture.document("alert-host.document.json")
    XCTAssertNil(Session.renderAlert(document: document, backend: .axbridge, screen: screen))
  }

  func testBridgeAlertPayloadMatchesGolden() throws {
    let document = try DocumentFixture.document("alert-bridge.document.json")
    let alert = try XCTUnwrap(Session.renderAlert(document: document, backend: .axbridge, screen: screen))
    try DocumentFixture.assertGolden(alert, named: "alert-bridge.alert.golden.json")
    XCTAssertEqual(
      alert["buttons"]?.arrayValue?.compactMap { $0["label"]?.stringValue },
      ["Allow Once", "Allow While Using App", "Don’t Allow"])
  }

  func testBridgeSnapshotReportsTheModal() throws {
    let data = try snapshot("alert-bridge.document.json", backend: .axbridge, interactiveOnly: true)
    try DocumentFixture.assertGolden(payload(data), named: "alert-bridge.snapshot.golden.json")
    let modal = try XCTUnwrap(data["modal"])
    XCTAssertEqual(modal["description"], .string("Allow “Maps” to use your location?"))
    XCTAssertNotNil(modal["pid"]?.intValue)
  }

  /// The iOS Keychain "Save Password?" sheet over the example app (Release build, iOS 26): app-process UI, so it is
  /// in the app's own tree as `_UIAlertControllerPhoneTVMacView`, and only axbridge sees it (host `ax` reads the app
  /// as one empty root).
  func testKeychainSheetButtonsAreListedFromTheBridgeTree() throws {
    let document = try DocumentFixture.document("keychain-sheet.document.json")
    let alert = try XCTUnwrap(Session.renderAlert(document: document, backend: .axbridge, screen: screen))
    XCTAssertEqual(alert["title"], .string("Save Password?"))
    XCTAssertEqual(
      alert["message"], .string("Securely store your password so it’s filled automatically the next time you need it."))
    let buttons = try XCTUnwrap(alert["buttons"]?.arrayValue)
    XCTAssertEqual(buttons.compactMap { $0["label"]?.stringValue }, ["Not Now", "Save"])
    for button in buttons {
      XCTAssertEqual(button["role"], .string("button"))
      XCTAssertNotNil(button["tapPoint"]?["x"]?.doubleValue)
      XCTAssertNotNil(button["tapPoint"]?["y"]?.doubleValue)
    }
  }

  func testKeychainSheetSetsTheModalOnASnapshot() throws {
    let data = try snapshot("keychain-sheet.document.json", backend: .axbridge, interactiveOnly: false)
    let modal = try XCTUnwrap(data["modal"])
    XCTAssertEqual(modal["description"], .string("Save Password?"))
    XCTAssertNotNil(modal["pid"]?.intValue)
  }

  /// Safari's "Open this page in ..." prompt is an in-page `SFDialogView` (no UIKit alert controller) while a
  /// "View Bookmarks ..." tip popover is drawn over it. The dialog's Cancel / Open win; the popover's Close does not.
  func testDialogBeatsATipPopoverDrawnOverIt() throws {
    let document = try DocumentFixture.document("safari-open-in.document.json")
    let alert = try XCTUnwrap(Session.renderAlert(document: document, backend: .axbridge, screen: screen))
    XCTAssertEqual(alert["title"], .string("Open this page in “warden-example”?"))
    XCTAssertEqual(alert["buttons"]?.arrayValue?.compactMap { $0["label"]?.stringValue }, ["Cancel", "Open"])
  }

  func testDialogSetsTheModalOverAPopover() throws {
    let data = try snapshot("safari-open-in.document.json", backend: .axbridge, interactiveOnly: false)
    let modal = try XCTUnwrap(data["modal"])
    XCTAssertEqual(modal["description"], .string("Open this page in “warden-example”?"))
  }

  func testAPopoverAloneIsStillReported() throws {
    let stripped = AccessibilityDocument(
      elements: try DocumentFixture.document("safari-open-in.document.json").elements.map(Self.withoutDialogs),
      modal: nil, truncated: false, screen: nil)
    let alert = try XCTUnwrap(Session.renderAlert(document: stripped, backend: .axbridge, screen: screen))
    XCTAssertEqual(alert["buttons"]?.arrayValue?.compactMap { $0["label"]?.stringValue }, ["Close"])
  }

  /// Drops every `SFDialogView` subtree so only the popover is left.
  private static func withoutDialogs(_ node: AccessibilityDocumentElement) -> AccessibilityDocumentElement {
    var copy = node
    copy.children = (node.children ?? []).filter { $0.type != "SFDialogView" }.map(withoutDialogs)
    return copy
  }

  func testPlainScreenHasNoAlertAndNoModal() throws {
    let document = try DocumentFixture.document("sign-in.document.json")
    XCTAssertNil(Session.renderAlert(document: document, backend: .axbridge, screen: screen))
    XCTAssertNil(Session.renderAlert(document: document, backend: .ax, screen: screen))
  }

  // MARK: request parsing

  func testSnapshotRequestParsing() throws {
    let request = try SnapshotRequest(
      ["interactiveOnly": true, "backend": "ax", "maxNodes": 50, "maxDepth": 8, "keys": ["reachability"]])
    XCTAssertTrue(request.interactiveOnly)
    XCTAssertEqual(request.backend, .ax)
    XCTAssertEqual(request.maxNodes, 50)
    XCTAssertEqual(request.maxDepth, 8)
    XCTAssertTrue(request.keys.contains(.interactable))
    XCTAssertTrue(request.keys.isSuperset(of: [.label, .frameDict, .type, .uniqueID, .traits, .placeholder]))

    let plain = try SnapshotRequest(["op": "snapshot"])
    XCTAssertNil(plain.backend)
    XCTAssertFalse(plain.keys.contains(.interactable))
  }

  func testSnapshotRequestRejectsBadParams() {
    XCTAssertThrowsError(try SnapshotRequest(["backend": "uiautomator"])) { error in
      XCTAssertEqual((error as? WireError)?.code, .badRequest)
    }
    XCTAssertThrowsError(try SnapshotRequest(["maxNodes": 0])) { error in
      XCTAssertEqual((error as? WireError)?.code, .badRequest)
    }
  }

  func testBridgeFailuresTriggerFallbackButOthersDoNot() {
    XCTAssertTrue(Session.isBridgeFailure(AXBridgeError.bridgeUnavailable))
    XCTAssertTrue(Session.isBridgeFailure(AXBridgeError.readerUnavailable("no reader")))
    XCTAssertTrue(Session.isBridgeFailure(AXBridgeError.applicationUnavailable(pid: 1)))
    XCTAssertTrue(Session.isBridgeFailure(AXBridgeError.applicationNotResponding(pid: 1)))
    XCTAssertTrue(Session.isBridgeFailure(UIAutomationError.applicationUnavailable(backend: .accessibility, pid: 1)))
    XCTAssertTrue(Session.isBridgeFailure(UIAutomationError.applicationNotResponding(backend: .accessibility, pid: 1)))
    XCTAssertFalse(Session.isBridgeFailure(UIAutomationError.noElementAtPoint(backend: .accessibility, x: 0, y: 0)))
    XCTAssertFalse(Session.isBridgeFailure(WireError(.timeout, "slow")))
  }
}
