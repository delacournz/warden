import FBSimulatorAX
import Foundation
import XCTest

@testable import warden_simd

final class ElementTests: XCTestCase {
  private let options = ElementBuilder.Options(screenWidth: 400, screenHeight: 800)

  private func node(
    type: String, label: String? = nil, identifier: String? = nil, value: AccessibilityAttributeValue? = nil,
    traits: [String] = [], frame: AccessibilityFrame? = AccessibilityFrame(x: 10, y: 20, width: 100, height: 40),
    children: [AccessibilityDocumentElement] = []
  ) -> AccessibilityDocumentElement {
    var node = AccessibilityDocumentElement(children: children)
    node.type = .some(type)
    node.label = .some(label)
    node.identifier = .some(identifier)
    node.value = .some(value)
    node.traits = .some(traits)
    node.frame = .some(frame)
    return node
  }

  // MARK: role map

  func testRoleMapTable() {
    let expected: [(String, Role)] = [
      ("Button", .button), ("StaticText", .text), ("TextField", .textfield), ("TextView", .textfield),
      ("SecureTextField", .securefield), ("SearchField", .searchfield), ("Image", .image), ("Icon", .image),
      ("Switch", .switch), ("Toggle", .switch), ("CheckBox", .checkbox), ("Slider", .slider), ("Link", .link),
      ("Cell", .cell), ("TableRow", .cell), ("Table", .list), ("CollectionView", .list), ("ScrollView", .scrollview),
      ("Tab", .tab), ("TabBar", .tabbar), ("Alert", .alert), ("Sheet", .sheet), ("Keyboard", .keyboard),
      ("NavigationBar", .navbar), ("Toolbar", .toolbar), ("Window", .window), ("Application", .application),
      ("Other", .other), ("Group", .other), ("SwiftUI.AccessibilityNode", .other), ("RCTViewComponentView", .other),
    ]
    for (type, role) in expected {
      XCTAssertEqual(RoleMap.role(forType: type, traits: []), role, type)
    }
  }

  func testButtonTraitUpgradesOtherOnly() {
    XCTAssertEqual(RoleMap.role(forType: "Other", traits: ["button"]), .button)
    XCTAssertEqual(RoleMap.role(forType: "RCTViewComponentView", traits: ["button", "scrollable"]), .button)
    XCTAssertEqual(RoleMap.role(forType: "StaticText", traits: ["button"]), .text)
    XCTAssertEqual(RoleMap.role(forType: "Image", traits: ["button"]), .image)
  }

  func testEveryMappedRoleIsAKnownRole() {
    XCTAssertTrue(Set(RoleMap.table.values).isSubset(of: Set(Role.allCases)))
  }

  // MARK: traits

  func testTraitNamesAreLowercaseKebab() {
    XCTAssertEqual(
      TraitNames.normalize([
        "Button", "StaticText", "NotEnabled", "UpdatesFrequently", "PlaysSound", "SummaryElement",
        "AllowsDirectInteraction", "CausesPageTurn", "TabBar", "KeyboardKey", "Header", "Link", "Image",
        "Adjustable", "Selected",
      ]),
      [
        "button", "static-text", "not-enabled", "updates-frequently", "plays-sound", "summary-element",
        "allows-direct-interaction", "causes-page-turn", "tab-bar", "keyboard-key", "header", "link", "image",
        "adjustable", "selected",
      ])
  }

  func testSearchFieldIsOneWordAndNoneIsDropped() {
    XCTAssertEqual(TraitNames.normalize(["SearchField", "TextEntry"]), ["searchfield", "text-entry"])
    XCTAssertEqual(TraitNames.normalize(["None"]), [])
    XCTAssertEqual(TraitNames.normalize(["Button", "Unknown"]), ["button"])
  }

  // MARK: node -> element

  func testPathIdsDepthNormFrameAndText() {
    let tree = node(
      type: "Other", label: "root",
      children: [
        node(type: "StaticText", label: "hello"),
        node(type: "Other", children: [node(type: "Button", label: "go", identifier: "go-btn")]),
      ])
    let built = ElementBuilder.build([tree], options: options).elements
    XCTAssertEqual(built.flatMap(\.preorder).map(\.id), ["0", "0.0", "0.1", "0.1.0"])
    XCTAssertEqual(built.flatMap(\.preorder).map(\.depth), [0, 1, 1, 2])
    let text = built[0].children[0]
    XCTAssertEqual(text.text, "hello")
    XCTAssertEqual(text.role, .text)
    XCTAssertEqual(text.normFrame, Rect(x: 10.0 / 400, y: 20.0 / 800, width: 100.0 / 400, height: 40.0 / 800))
    let button = built[0].children[1].children[0]
    XCTAssertEqual(button.identifier, "go-btn")
    XCTAssertEqual(button.tapPoint, Point(x: 60, y: 40))
    XCTAssertEqual(button.rawType, "Button")
  }

  func testEmptyStringsAreOmitted() {
    let built = ElementBuilder.convert(
      node(type: "Button", label: "", identifier: "", value: .string("")), path: "0", depth: 0, options: options)
    XCTAssertNil(built.label)
    XCTAssertNil(built.identifier)
    XCTAssertNil(built.value)
  }

  func testSwitchCheckedFromValue() {
    func checked(_ value: AccessibilityAttributeValue?) -> Bool? {
      ElementBuilder.convert(node(type: "Switch", value: value), path: "0", depth: 0, options: options).checked
    }
    XCTAssertEqual(checked(.string("1")), true)
    XCTAssertEqual(checked(.string("0")), false)
    XCTAssertEqual(checked(.int(1)), true)
    XCTAssertEqual(checked(.bool(false)), false)
    XCTAssertNil(checked(.string("maybe")))
    XCTAssertNil(checked(nil))
    let text = ElementBuilder.convert(node(type: "TextField", value: .string("1")), path: "0", depth: 0, options: options)
    XCTAssertNil(text.checked)
  }

  func testSelectedAndEnabledComeFromTraits() {
    let selected = ElementBuilder.convert(
      node(type: "Button", traits: ["Button", "Selected"]), path: "0", depth: 0, options: options)
    XCTAssertEqual(selected.selected, true)
    XCTAssertEqual(selected.traits, ["button", "selected"])
    let disabled = ElementBuilder.convert(
      node(type: "Button", traits: ["Button", "NotEnabled"]), path: "0", depth: 0, options: options)
    XCTAssertFalse(disabled.enabled)
    XCTAssertEqual(selected.enabled, true)
  }

  func testHittableIsDerivedWithoutReachabilityKeys() {
    func hittable(_ frame: AccessibilityFrame?, hidden: Bool? = nil, traits: [String] = []) -> Bool? {
      var raw = node(type: "Button", traits: traits, frame: frame)
      if let hidden { raw.hidden = .some(hidden) }
      return ElementBuilder.convert(raw, path: "0", depth: 0, options: options).hittable
    }
    XCTAssertEqual(hittable(AccessibilityFrame(x: 0, y: 0, width: 50, height: 50)), true)
    XCTAssertEqual(hittable(AccessibilityFrame(x: 0, y: 900, width: 50, height: 50)), false)
    XCTAssertEqual(hittable(AccessibilityFrame(x: 0, y: 0, width: 0, height: 50)), false)
    XCTAssertEqual(hittable(AccessibilityFrame(x: 0, y: 0, width: 50, height: 50), hidden: true), false)
    XCTAssertEqual(hittable(AccessibilityFrame(x: 0, y: 0, width: 50, height: 50), traits: ["NotEnabled"]), false)
    XCTAssertEqual(hittable(nil), false)
  }

  func testReachabilityVerdictWinsAndSuppliesTapPoint() {
    var actionable = node(type: "Button")
    actionable.interactable = .some(.actionable(at: AccessibilityPoint(x: 33, y: 44)))
    let yes = ElementBuilder.convert(actionable, path: "0", depth: 0, options: options)
    XCTAssertEqual(yes.hittable, true)
    XCTAssertEqual(yes.tapPoint, Point(x: 33, y: 44))

    var blocked = node(type: "Button")
    blocked.interactable = .some(.blocked(reasons: [.notHittable]))
    let no = ElementBuilder.convert(blocked, path: "0", depth: 0, options: options)
    XCTAssertEqual(no.hittable, false)
    XCTAssertEqual(no.tapPoint, Point(x: 60, y: 40))

    var unanswered = node(type: "Button")
    unanswered.interactable = .some(nil)
    XCTAssertEqual(ElementBuilder.convert(unanswered, path: "0", depth: 0, options: options).hittable, true)
  }

  func testMissingTypeFallsBackToRole() {
    var raw = AccessibilityDocumentElement()
    raw.role = .some("AXButton")
    raw.frame = .some(AccessibilityFrame(x: 0, y: 0, width: 1, height: 1))
    let element = ElementBuilder.convert(raw, path: "0", depth: 0, options: options)
    XCTAssertEqual(element.rawType, "Button")
    XCTAssertEqual(element.role, .button)
    let bare = ElementBuilder.convert(AccessibilityDocumentElement(), path: "0", depth: 0, options: options)
    XCTAssertEqual(bare.rawType, "Other")
    XCTAssertEqual(bare.frame, .zero)
  }

  func testNonFiniteFrameEdgesBecomeZero() {
    let element = ElementBuilder.convert(
      node(type: "Button", frame: AccessibilityFrame(x: .infinity, y: 5, width: 10, height: .nan)), path: "0", depth: 0,
      options: options)
    XCTAssertEqual(element.frame, Rect(x: 0, y: 5, width: 10, height: 0))
  }

  // MARK: filters

  func testInteractiveOnlyKeepsInteractiveIdentifiedAndAncestors() {
    let tree = node(
      type: "Other",
      children: [
        node(type: "StaticText", label: "decor"),
        node(type: "Other", children: [node(type: "TextField", identifier: "email")]),
        node(type: "Other", identifier: "banner", children: [node(type: "Image")]),
        node(type: "Other", children: [node(type: "Image"), node(type: "StaticText", label: "more")]),
        node(type: "Key", traits: ["KeyboardKey"]),
      ])
    let all = ElementBuilder.build([tree], options: options)
    let filtered = ElementBuilder.build(
      [tree], options: ElementBuilder.Options(screenWidth: 400, screenHeight: 800, interactiveOnly: true))
    XCTAssertEqual(all.elements.flatMap(\.preorder).count, 10)
    XCTAssertEqual(filtered.elements.flatMap(\.preorder).map(\.id), ["0", "0.1", "0.1.0", "0.2"])
    XCTAssertFalse(filtered.truncated)
  }

  func testMaxNodesAndMaxDepthTruncate() {
    let tree = node(
      type: "Other",
      children: [
        node(type: "Button", children: [node(type: "Image")]),
        node(type: "Button"),
        node(type: "Button"),
      ])
    let capped = ElementBuilder.build(
      [tree], options: ElementBuilder.Options(screenWidth: 400, screenHeight: 800, maxNodes: 3))
    XCTAssertEqual(capped.elements.flatMap(\.preorder).map(\.id), ["0", "0.0", "0.0.0"])
    XCTAssertTrue(capped.truncated)

    let shallow = ElementBuilder.build(
      [tree], options: ElementBuilder.Options(screenWidth: 400, screenHeight: 800, maxDepth: 2))
    XCTAssertEqual(shallow.elements.flatMap(\.preorder).map(\.id), ["0", "0.0", "0.1", "0.2"])
    XCTAssertTrue(shallow.truncated)

    let whole = ElementBuilder.build(
      [tree], options: ElementBuilder.Options(screenWidth: 400, screenHeight: 800, maxDepth: 5, maxNodes: 50))
    XCTAssertFalse(whole.truncated)
  }

  // MARK: JSON

  func testJSONMatchesCodable() throws {
    let tree = node(
      type: "Switch", label: "Dark mode", identifier: "dark", value: .string("1"), traits: ["Button", "Selected"],
      children: [node(type: "StaticText", label: "child")])
    var raw = tree
    raw.placeholder = .some("hint")
    raw.hidden = .some(false)
    raw.focused = .some(true)
    raw.pid = .some(42)
    raw.interactable = .some(.actionable(at: AccessibilityPoint(x: 1, y: 2)))
    let element = ElementBuilder.convert(raw, path: "0", depth: 0, options: options)

    let viaCodable = try JSONSerialization.jsonObject(with: JSONEncoder().encode(element)) as AnyObject
    let viaJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(element.json)) as AnyObject
    XCTAssertTrue(viaCodable.isEqual(viaJSON), "Element.json drifted from Element's Codable encoding")
    let roundTrip = try JSONDecoder().decode(Element.self, from: JSONEncoder().encode(element))
    XCTAssertEqual(roundTrip, element)
  }

  func testUnsetOptionalsAreOmittedNotNull() throws {
    let element = ElementBuilder.convert(AccessibilityDocumentElement(), path: "0", depth: 0, options: options)
    let fields = try XCTUnwrap(element.json.objectValue)
    for key in ["label", "identifier", "value", "text", "placeholder", "focused", "selected", "checked", "pid"] {
      XCTAssertNil(fields[key], key)
    }
    XCTAssertEqual(fields["children"], .array([]))
  }
}
