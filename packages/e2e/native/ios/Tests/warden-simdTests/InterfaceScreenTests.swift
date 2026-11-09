import FBSimulatorAX
import XCTest

@testable import warden_simd

/// A snapshot's screen is the app's interface: AX frames of an app turned with the device are landscape (874×402 on a
/// 402×874 iPhone), so measuring them against the portrait size marks the right half off screen (`hittable: false`,
/// `normFrame` past 1) and a spec cannot tap it. A portrait-locked app on a turned device stays portrait.
final class InterfaceScreenTests: XCTestCase {
  private let portrait: (width: Double, height: Double, scale: Double) = (402, 874, 3)

  private func app(width: Double, height: Double, children: [[String: Any]]) -> AccessibilityDocumentElement {
    DocumentFixture.element([
      "type": "Application", "label": "warden-example", "enabled": true,
      "frame": ["x": 0, "y": 0, "width": width, "height": height], "children": children,
    ])
  }

  private let topRight: [String: Any] = [
    "type": "Button", "identifier": "landscape-top-right", "label": "Top right", "enabled": true,
    "frame": ["x": 768, "y": 64, "width": 86, "height": 36],
  ]

  func testALandscapeRootTurnsTheScreen() {
    let size = Session.interfaceScreen(portrait, roots: [app(width: 874, height: 402, children: [])])
    XCTAssertEqual(size.width, 874)
    XCTAssertEqual(size.height, 402)
    XCTAssertEqual(size.scale, 3)
  }

  func testAPortraitRootKeepsTheScreen() {
    let size = Session.interfaceScreen(portrait, roots: [app(width: 402, height: 874, children: [])])
    XCTAssertEqual(size.width, 402)
    XCTAssertEqual(size.height, 874)
  }

  func testNoRootOrNoFrameKeepsTheScreen() {
    XCTAssertEqual(Session.interfaceScreen(portrait, roots: []).width, 402)
    let frameless = DocumentFixture.element(["type": "Application", "enabled": true])
    XCTAssertEqual(Session.interfaceScreen(portrait, roots: [frameless]).width, 402)
  }

  /// A small landscape element at the top (a banner, an alert host) is not the interface turning.
  func testASmallWideRootDoesNotTurnTheScreen() {
    let banner = DocumentFixture.element([
      "type": "Application", "enabled": true, "frame": ["x": 0, "y": 0, "width": 402, "height": 100],
    ])
    XCTAssertEqual(Session.interfaceScreen(portrait, roots: [banner]).width, 402)
  }

  func testUnknownScreenIsLeftAlone() {
    let size = Session.interfaceScreen((0, 0, 0), roots: [app(width: 874, height: 402, children: [])])
    XCTAssertEqual(size.width, 0)
  }

  func testALandscapeSnapshotKeepsItsRightHalfHittable() throws {
    let document = AccessibilityDocument(elements: [app(width: 874, height: 402, children: [topRight])])
    let data = Session.renderSnapshot(
      document: document, backend: .axbridge, screen: portrait, interactiveOnly: false)
    XCTAssertEqual(data["screen"]?["width"], .double(874))
    XCTAssertEqual(data["screen"]?["height"], .double(402))
    let root = try XCTUnwrap(data["elements"]?.arrayValue?.first)
    let button = try XCTUnwrap(root["children"]?.arrayValue?.first)
    XCTAssertEqual(button["identifier"], "landscape-top-right")
    XCTAssertEqual(button["hittable"], .bool(true))
    let norm = try XCTUnwrap(button["normFrame"]?["x"]?.doubleValue)
    XCTAssertLessThan(norm, 1)
  }
}
