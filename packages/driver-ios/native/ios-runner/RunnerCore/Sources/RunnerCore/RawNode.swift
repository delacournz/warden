import Foundation

/// One XCUITest snapshot node, reduced to what the encoder needs. The XCTest glue fills it from `XCUIElementSnapshot`;
/// tests and goldens read it from JSON. `frame` is in interface space (see `FrameSpace`).
struct RawNode: Codable, Equatable, Sendable {
  /// `XCUIElement.ElementType` case name capitalised the way the role map spells it (`Button`, `StaticText`, `Other`).
  var type: String
  var label: String
  var identifier: String
  var value: String?
  var placeholder: String?
  var frame: Rect
  var enabled: Bool
  var selected: Bool
  var hasFocus: Bool
  var children: [RawNode]

  init(
    type: String, label: String = "", identifier: String = "", value: String? = nil, placeholder: String? = nil,
    frame: Rect, enabled: Bool = true, selected: Bool = false, hasFocus: Bool = false, children: [RawNode] = []
  ) {
    self.type = type
    self.label = label
    self.identifier = identifier
    self.value = value
    self.placeholder = placeholder
    self.frame = frame
    self.enabled = enabled
    self.selected = selected
    self.hasFocus = hasFocus
    self.children = children
  }

  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    type = try c.decode(String.self, forKey: .type)
    label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
    identifier = try c.decodeIfPresent(String.self, forKey: .identifier) ?? ""
    value = try c.decodeIfPresent(String.self, forKey: .value)
    placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder)
    frame = try c.decode(Rect.self, forKey: .frame)
    enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    selected = try c.decodeIfPresent(Bool.self, forKey: .selected) ?? false
    hasFocus = try c.decodeIfPresent(Bool.self, forKey: .hasFocus) ?? false
    children = try c.decodeIfPresent([RawNode].self, forKey: .children) ?? []
  }

  /// This node and every descendant, preorder.
  var preorder: [RawNode] { [self] + children.flatMap(\.preorder) }

  private enum Keys: String, CodingKey {
    case type, label, identifier, value, placeholder, frame, enabled, selected, hasFocus, children
  }
}
