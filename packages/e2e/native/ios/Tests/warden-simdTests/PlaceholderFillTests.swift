import FBSimulatorAX
import Foundation
import XCTest

@testable import warden_simd

/// The bridge reader leaves `placeholder` empty on React Native inputs while iOS shows the placeholder as the value of
/// an empty field; the host `ax` reader names it. `PlaceholderFill` asks the host once per field and remembers.
final class PlaceholderFillTests: XCTestCase {
  private let screen = DocumentFixture.screen

  private func bridgeDocument() throws -> AccessibilityDocument {
    try DocumentFixture.document("sign-in.document.json")
  }

  /// The host hit-test answer for a bridge text field: the same node with the placeholder the host names.
  private static func hostNode(for key: PlaceholderKey, placeholder: String?) -> AccessibilityDocumentElement {
    var fields: [String: Any] = [
      "type": "TextField",
      "identifier": key.identifier ?? NSNull(),
      "placeholder": placeholder ?? NSNull(),
      "frame": ["x": Double(key.x), "y": Double(key.y), "width": Double(key.width), "height": Double(key.height)],
    ]
    if let placeholder { fields["value"] = placeholder }
    return DocumentFixture.element(fields)
  }

  func testBridgeTextFieldsWithAValueAndNoPlaceholderAreCandidates() throws {
    let candidates = PlaceholderFill.candidates(try bridgeDocument().elements)
    XCTAssertEqual(candidates.map(\.key.identifier), ["sign-in-email", "sign-in-password"])
    let email = try XCTUnwrap(candidates.first)
    XCTAssertEqual(email.point, CGPoint(x: 201, y: 230))
  }

  func testAFieldThatNamesItsPlaceholderOrHoldsNothingIsNoCandidate() {
    let named = DocumentFixture.element([
      "type": "TextField", "placeholder": "Email", "value": "Email",
      "frame": ["x": 0.0, "y": 0.0, "width": 100.0, "height": 40.0],
    ])
    let empty = DocumentFixture.element([
      "type": "TextField", "placeholder": NSNull(), "value": NSNull(),
      "frame": ["x": 0.0, "y": 50.0, "width": 100.0, "height": 40.0],
    ])
    let button = DocumentFixture.element([
      "type": "Button", "value": "1", "frame": ["x": 0.0, "y": 100.0, "width": 100.0, "height": 40.0],
    ])
    XCTAssertTrue(PlaceholderFill.candidates([named, empty, button]).isEmpty)
  }

  func testEachFieldIsAskedOnceAndRemembered() async throws {
    let candidates = PlaceholderFill.candidates(try bridgeDocument().elements)
    let memory = PlaceholderMemory()
    let calls = Counter()
    let answers: [String: String] = ["sign-in-email": "ada@example.com", "sign-in-password": "At least 8 characters"]
    let hit: PlaceholderFill.HitTest = { point in
      calls.increment()
      let candidate = try XCTUnwrap(candidates.first { $0.point == point })
      return PlaceholderFillTests.hostNode(for: candidate.key, placeholder: answers[candidate.key.identifier ?? ""])
    }
    for _ in 0..<2 {
      let found = await PlaceholderFill.resolve(candidates, memory: memory, now: 100, hit: hit)
      XCTAssertEqual(found.count, 2)
      XCTAssertEqual(found.first { $0.key.identifier == "sign-in-email" }?.value, "ada@example.com")
    }
    XCTAssertEqual(calls.value, 2)
  }

  func testAFieldWithoutAPlaceholderIsRememberedAsNone() async throws {
    let candidates = Array(PlaceholderFill.candidates(try bridgeDocument().elements).prefix(1))
    let memory = PlaceholderMemory()
    let calls = Counter()
    let hit: PlaceholderFill.HitTest = { _ in
      calls.increment()
      return PlaceholderFillTests.hostNode(for: candidates[0].key, placeholder: nil)
    }
    let first = await PlaceholderFill.resolve(candidates, memory: memory, now: 100, hit: hit)
    let second = await PlaceholderFill.resolve(candidates, memory: memory, now: 101, hit: hit)
    XCTAssertTrue(first.isEmpty)
    XCTAssertTrue(second.isEmpty)
    XCTAssertEqual(calls.value, 1)
  }

  func testAHitOnAnotherElementTeachesNothing() async throws {
    let candidates = Array(PlaceholderFill.candidates(try bridgeDocument().elements).prefix(1))
    let memory = PlaceholderMemory()
    let other = PlaceholderKey(
      pid: nil, identifier: "keyboard-overlay", label: nil, x: 0, y: 200, width: 402, height: 300)
    let found = await PlaceholderFill.resolve(
      candidates, memory: memory, now: 100, hit: { _ in PlaceholderFillTests.hostNode(for: other, placeholder: "Search") })
    XCTAssertTrue(found.isEmpty)
    XCTAssertEqual(memory.lookup(candidates[0].key), .unknown)
  }

  func testAFailedHitBacksOffForEveryField() async throws {
    let candidates = PlaceholderFill.candidates(try bridgeDocument().elements)
    let memory = PlaceholderMemory()
    let calls = Counter()
    let failing: PlaceholderFill.HitTest = { _ in
      calls.increment()
      throw CancellationError()
    }
    _ = await PlaceholderFill.resolve(candidates, memory: memory, now: 100, hit: failing)
    XCTAssertEqual(calls.value, 1)
    _ = await PlaceholderFill.resolve(candidates, memory: memory, now: 100 + PlaceholderFill.backoffSeconds - 1, hit: failing)
    XCTAssertEqual(calls.value, 1)
    _ = await PlaceholderFill.resolve(candidates, memory: memory, now: 100 + PlaceholderFill.backoffSeconds, hit: failing)
    XCTAssertEqual(calls.value, 2)
  }

  func testBuildFillsThePlaceholderTheBridgeLeftOut() throws {
    let document = try bridgeDocument()
    let key = try XCTUnwrap(PlaceholderFill.candidates(document.elements).first?.key)
    var options = Session.buildOptions(screen: screen, document: document.screen)
    options.placeholders = [key: "ada@example.com"]
    let nodes = ElementBuilder.build(document.elements, options: options).elements.flatMap(\.preorder)
    let email = try XCTUnwrap(nodes.first { $0.identifier == "sign-in-email" })
    XCTAssertEqual(email.placeholder, "ada@example.com")
    XCTAssertEqual(email.value, "ada@example.com")
    let password = try XCTUnwrap(nodes.first { $0.identifier == "sign-in-password" })
    XCTAssertNil(password.placeholder)
  }
}

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var value: Int { lock.withLock { count } }
  func increment() { lock.withLock { count += 1 } }
}
