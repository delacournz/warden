import XCTest

@testable import RunnerCore

final class SnapshotEncoderTests: XCTestCase {
  private let portrait = FrameSpace(interface: .portrait, width: 440, height: 956)
  private let landscapeLeft = FrameSpace(interface: .landscapeLeft, width: 440, height: 956)

  private func snapshot(
    _ raw: String, space: FrameSpace, options: SnapshotEncoder.Options = .init()
  ) throws -> (SnapshotEncoder.Output, JSON) {
    let output = SnapshotEncoder.build(root: try Fixture.raw(raw), space: space, options: options)
    return (output, SnapshotEncoder.snapshotData(output, screen: Fixture.screen, ms: 0))
  }

  private func node(_ id: String, in output: SnapshotEncoder.Output) throws -> Element {
    try XCTUnwrap(output.elements.flatMap(\.preorder).first { $0.identifier == id })
  }

  // MARK: goldens

  func testSignInSnapshotMatchesGolden() throws {
    let (output, data) = try snapshot("sign-in.raw.json", space: portrait)
    try Fixture.assertGolden(data, named: "sign-in.snapshot.golden.json")
    XCTAssertFalse(output.truncated)
    XCTAssertEqual(data["backend"], "ax")
  }

  func testSignInInteractiveSnapshotMatchesGolden() throws {
    let (_, data) = try snapshot("sign-in.raw.json", space: portrait, options: .init(interactiveOnly: true))
    try Fixture.assertGolden(data, named: "sign-in.interactive.golden.json")
  }

  func testLandscapeSnapshotIsThePortraitSnapshot() throws {
    let (_, portraitData) = try snapshot("sign-in.raw.json", space: portrait)
    let (_, landscapeData) = try snapshot("sign-in-landscape-left.raw.json", space: landscapeLeft)
    XCTAssertEqual(landscapeData, portraitData)
    try Fixture.assertGolden(landscapeData, named: "sign-in-landscape-left.snapshot.golden.json")
  }

  func testAlertMatchesGolden() throws {
    let data = SnapshotEncoder.alertData(from: try Fixture.raw("alert.raw.json"), space: portrait)
    try Fixture.assertGolden(data, named: "alert.alert.golden.json")
    XCTAssertEqual(data["title"], "Allow “Maps” to use your location?")
    XCTAssertEqual(data["message"], "Your location is used to show directions.")
    XCTAssertEqual(data["buttons"]?.arrayValue?.count, 3)
  }

  // MARK: element mapping

  func testRolesFollowTheElementType() throws {
    let (output, _) = try snapshot("sign-in.raw.json", space: portrait)
    XCTAssertEqual(output.elements.first?.role, .application)
    XCTAssertEqual(try node("sign-in-email", in: output).role, .textfield)
    XCTAssertEqual(try node("sign-in-password", in: output).role, .securefield)
    XCTAssertEqual(try node("sign-in-submit", in: output).role, .button)
    XCTAssertEqual(try node("sign-in-remember", in: output).role, .switch)
    XCTAssertEqual(try node("sign-in-back", in: output).role, .button)
    XCTAssertEqual(try node("Sign in", in: output).role, .navbar)
  }

  func testIdsAreTheUnfilteredPreorderPath() throws {
    let (full, _) = try snapshot("sign-in.raw.json", space: portrait)
    let (interactive, _) = try snapshot("sign-in.raw.json", space: portrait, options: .init(interactiveOnly: true))
    for id in ["sign-in-email", "sign-in-submit", "sign-in-back"] {
      XCTAssertEqual(try node(id, in: full).id, try node(id, in: interactive).id, id)
    }
    for element in full.elements.flatMap(\.preorder) {
      XCTAssertEqual(element.id.split(separator: ".").count, element.depth + 1)
    }
  }

  func testFieldsCarryValuePlaceholderFocusAndTapPoint() throws {
    let (output, _) = try snapshot("sign-in.raw.json", space: portrait)
    let email = try node("sign-in-email", in: output)
    XCTAssertEqual(email.value, "chris@delacour.co.nz")
    XCTAssertEqual(email.placeholder, "Email")
    XCTAssertEqual(email.focused, true)
    XCTAssertTrue(email.traits.contains("is-editing"))
    XCTAssertEqual(email.tapPoint, Point(x: 220, y: 224))
    XCTAssertEqual(email.hittable, true)
    XCTAssertEqual(try node("sign-in-password", in: output).focused, false)
  }

  func testSwitchValueBecomesChecked() throws {
    let (output, _) = try snapshot("sign-in.raw.json", space: portrait)
    XCTAssertEqual(try node("sign-in-remember", in: output).checked, true)
    XCTAssertEqual(SnapshotEncoder.checked(role: .switch, value: "0"), false)
    XCTAssertNil(SnapshotEncoder.checked(role: .button, value: "1"))
  }

  func testDisabledAndZeroAreaNodesAreNotHittable() throws {
    let (output, _) = try snapshot("sign-in.raw.json", space: portrait)
    let submit = try node("sign-in-submit", in: output)
    XCTAssertFalse(submit.enabled)
    XCTAssertEqual(submit.hittable, false)
    XCTAssertTrue(submit.traits.contains("not-enabled"))
    let logo = try XCTUnwrap(output.elements.flatMap(\.preorder).first { $0.label == "hidden-logo" })
    XCTAssertEqual(logo.hittable, false)
    XCTAssertNil(logo.tapPoint)
  }

  func testKeyboardKeysAreButtonsButNotInteractive() throws {
    let (output, _) = try snapshot("sign-in.raw.json", space: portrait)
    let key = try XCTUnwrap(output.elements.flatMap(\.preorder).first { $0.rawType == "Key" })
    XCTAssertEqual(key.role, .button)
    XCTAssertTrue(key.traits.contains("keyboard-key"))
    XCTAssertFalse(key.isInteractive)
    let (interactive, _) = try snapshot("sign-in.raw.json", space: portrait, options: .init(interactiveOnly: true))
    XCTAssertFalse(interactive.elements.flatMap(\.preorder).contains { $0.rawType == "Key" })
  }

  func testStaticTextHasText() throws {
    let (output, _) = try snapshot("sign-in.raw.json", space: portrait)
    let welcome = try XCTUnwrap(output.elements.flatMap(\.preorder).first { $0.label == "Welcome back" })
    XCTAssertEqual(welcome.text, "Welcome back")
    XCTAssertTrue(welcome.traits.contains("static-text"))
  }

  func testNormFrameIsAFractionOfThePortraitScreen() throws {
    let (output, _) = try snapshot("sign-in-landscape-left.raw.json", space: landscapeLeft)
    let email = try node("sign-in-email", in: output)
    XCTAssertEqual(email.frame, Rect(x: 24, y: 200, width: 392, height: 48))
    XCTAssertEqual(email.normFrame.x, 24.0 / 440, accuracy: 1e-9)
    XCTAssertEqual(email.normFrame.height, 48.0 / 956, accuracy: 1e-9)
  }

  func testUnknownTypesAreOther() {
    let raw = RawNode(type: "Matte", frame: Rect(x: 0, y: 0, width: 10, height: 10))
    XCTAssertEqual(SnapshotEncoder.build(root: raw, space: portrait).elements.first?.role, .other)
    let empty = RawNode(type: "", frame: Rect(x: 0, y: 0, width: 10, height: 10))
    XCTAssertEqual(SnapshotEncoder.build(root: empty, space: portrait).elements.first?.rawType, "Other")
  }

  func testEveryXCUITypeNameTheGlueEmitsMapsToTheRightRole() {
    let expected: [String: Role] = [
      "Button": .button, "StaticText": .text, "TextField": .textfield, "TextView": .textfield,
      "SecureTextField": .securefield, "SearchField": .searchfield, "Image": .image, "Switch": .switch,
      "CheckBox": .checkbox, "Slider": .slider, "Link": .link, "Cell": .cell, "Table": .list,
      "CollectionView": .list, "ScrollView": .scrollview, "Tab": .tab, "TabBar": .tabbar, "Alert": .alert,
      "Sheet": .sheet, "Keyboard": .keyboard, "NavigationBar": .navbar, "Toolbar": .toolbar, "Window": .window,
      "Application": .application, "Group": .other, "Other": .other, "WebView": .other,
    ]
    for (type, role) in expected {
      XCTAssertEqual(RoleMap.role(forType: type, traits: []), role, type)
    }
  }

  // MARK: limits

  func testMaxNodesTruncates() throws {
    let (output, data) = try snapshot("sign-in.raw.json", space: portrait, options: .init(maxNodes: 3))
    XCTAssertTrue(output.truncated)
    XCTAssertEqual(output.elements.flatMap(\.preorder).count, 3)
    XCTAssertEqual(data["truncated"], true)
    XCTAssertGreaterThan(output.nodes, 3)
  }

  func testMaxDepthTruncates() throws {
    let (output, _) = try snapshot("sign-in.raw.json", space: portrait, options: .init(maxDepth: 2))
    XCTAssertTrue(output.truncated)
    XCTAssertEqual(output.elements.flatMap(\.preorder).map(\.depth).max(), 1)
  }

  func testInteractiveOnlyKeepsEveryIdentifier() throws {
    let (full, _) = try snapshot("sign-in.raw.json", space: portrait)
    let (interactive, _) = try snapshot("sign-in.raw.json", space: portrait, options: .init(interactiveOnly: true))
    let ids = Set(full.elements.flatMap(\.preorder).compactMap(\.identifier))
    XCTAssertEqual(Set(interactive.elements.flatMap(\.preorder).compactMap(\.identifier)), ids)
    XCTAssertLessThan(interactive.elements.flatMap(\.preorder).count, full.elements.flatMap(\.preorder).count)
  }

  // MARK: payload

  func testSnapshotPayloadCarriesTheReaderAndTheFallbackNote() throws {
    let output = SnapshotEncoder.build(root: try Fixture.raw("sign-in.raw.json"), space: portrait)
    let note: JSON = ["from": "axbridge", "to": "ax", "reason": "no AX bridge on a physical device"]
    let data = SnapshotEncoder.snapshotData(output, screen: Fixture.screen, ms: 12.5, fallback: note)
    XCTAssertEqual(data["fallback"], note)
    XCTAssertEqual(data["ms"], .double(12.5))
    XCTAssertEqual(data["screen"], ["width": .double(440), "height": .double(956), "scale": .double(3)])
    XCTAssertEqual(data["nodes"], .int(output.nodes))
    XCTAssertNil(data["modal"])
  }

  func testRawNodeDecodesWithDefaults() throws {
    let raw = try JSONDecoder().decode(
      RawNode.self, from: Data(#"{"type":"Button","frame":{"x":1,"y":2,"width":3,"height":4}}"#.utf8))
    XCTAssertEqual(raw.label, "")
    XCTAssertTrue(raw.enabled)
    XCTAssertFalse(raw.selected)
    XCTAssertEqual(raw.children, [])
  }
}
