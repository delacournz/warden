import Foundation

// The normalized AX node `warden-simd` sends for `snapshot`, `elementAtPoint` and `alertButtons`. The shape is the
// TS `Element` of `packages/e2e/src/driver/driver.types.ts` (zod: `wireElementSchema` in `driver/ios/simd-protocol.ts`);
// optional fields are omitted when unknown, never `null`.

struct Rect: Codable, Equatable, Sendable {
  var x: Double
  var y: Double
  var width: Double
  var height: Double

  static let zero = Rect(x: 0, y: 0, width: 0, height: 0)

  var hasArea: Bool { width > 0 && height > 0 }
  var center: Point { Point(x: x + width / 2, y: y + height / 2) }

  func intersectsScreen(width screenWidth: Double, height screenHeight: Double) -> Bool {
    guard hasArea else { return false }
    return x < screenWidth && y < screenHeight && x + width > 0 && y + height > 0
  }

  /// `self` as 0-1 fractions of a screen; zeros when the screen size is unknown.
  func normalized(width screenWidth: Double, height screenHeight: Double) -> Rect {
    guard screenWidth > 0, screenHeight > 0 else { return .zero }
    return Rect(x: x / screenWidth, y: y / screenHeight, width: width / screenWidth, height: height / screenHeight)
  }

  var json: JSON {
    ["x": .double(x), "y": .double(y), "width": .double(width), "height": .double(height)]
  }
}

struct Point: Codable, Equatable, Sendable {
  var x: Double
  var y: Double

  var json: JSON { ["x": .double(x), "y": .double(y)] }
}

/// Mirror of the TS `Role` union.
enum Role: String, Codable, CaseIterable, Sendable {
  case button, text, textfield, securefield, searchfield, image, `switch`, checkbox, slider, link, cell, list
  case scrollview, tab, tabbar, alert, sheet, keyboard, navbar, toolbar, window, application, other
}

struct Element: Codable, Equatable, Sendable {
  var id: String
  var role: Role
  var rawType: String
  var label: String?
  var identifier: String?
  var value: String?
  var text: String?
  var placeholder: String?
  var frame: Rect
  var normFrame: Rect
  var traits: [String]
  var enabled: Bool
  var focused: Bool?
  var hidden: Bool?
  var selected: Bool?
  var checked: Bool?
  var hittable: Bool?
  var tapPoint: Point?
  var pid: Int?
  var depth: Int
  var children: [Element]

  /// Built by hand rather than through `JSONEncoder` + `JSON.init(from:)`: a snapshot is hundreds of nodes and the
  /// generic decode path costs milliseconds. `ElementTests.testJSONMatchesCodable` pins the two together.
  var json: JSON {
    var object: [String: JSON] = [
      "id": .string(id),
      "role": .string(role.rawValue),
      "rawType": .string(rawType),
      "frame": frame.json,
      "normFrame": normFrame.json,
      "traits": .array(traits.map(JSON.string)),
      "enabled": .bool(enabled),
      "depth": .int(depth),
      "children": .array(children.map(\.json)),
    ]
    if let label { object["label"] = .string(label) }
    if let identifier { object["identifier"] = .string(identifier) }
    if let value { object["value"] = .string(value) }
    if let text { object["text"] = .string(text) }
    if let placeholder { object["placeholder"] = .string(placeholder) }
    if let focused { object["focused"] = .bool(focused) }
    if let hidden { object["hidden"] = .bool(hidden) }
    if let selected { object["selected"] = .bool(selected) }
    if let checked { object["checked"] = .bool(checked) }
    if let hittable { object["hittable"] = .bool(hittable) }
    if let tapPoint { object["tapPoint"] = tapPoint.json }
    if let pid { object["pid"] = .int(pid) }
    return .object(object)
  }

  /// Interactive for `snapshot{interactiveOnly}`: an actionable role, except keyboard keys (the keyboard is driven
  /// through `typeText`/`key`, and ~40 key nodes would drown the screen).
  var isInteractive: Bool {
    switch role {
    case .button, .textfield, .securefield, .searchfield, .switch, .checkbox, .slider, .link, .cell, .tab:
      return !traits.contains("keyboard-key")
    default:
      return false
    }
  }

  /// This node and every descendant, preorder.
  var preorder: [Element] {
    [self] + children.flatMap(\.preorder)
  }
}

// MARK: - Traits

enum TraitNames {
  /// AX trait names arrive CamelCase (`StaticText`, `NotEnabled`); the wire uses lowercase kebab-case
  /// (`static-text`, `not-enabled`), except `SearchField`, which the TS side spells `searchfield`.
  /// `None` and `Unknown` carry no information and are dropped.
  static func normalize(_ names: [String]) -> [String] {
    var result: [String] = []
    for name in names where name != "None" && name != "Unknown" {
      let converted = kebab(name)
      result.append(converted == "search-field" ? "searchfield" : converted)
    }
    return result
  }

  static func kebab(_ name: String) -> String {
    var output = ""
    var previousLowerOrDigit = false
    for character in name {
      if character.isUppercase {
        if previousLowerOrDigit { output.append("-") }
        output.append(contentsOf: character.lowercased())
        previousLowerOrDigit = false
      } else {
        output.append(character)
        previousLowerOrDigit = character.isLowercase || character.isNumber
      }
    }
    return output
  }
}
