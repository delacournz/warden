import Foundation

/// A key `XCUIApplication.typeKey` can press. The XCTest glue maps `named` to the matching `XCUIKeyboardKey` constant
/// and passes `character` through as the key string.
enum KeyToken: Equatable, Sendable {
  case named(NamedKey)
  case character(String)
}

enum NamedKey: String, Equatable, Sendable {
  case enter, escape, delete, forwardDelete, tab, space
  case upArrow, downArrow, leftArrow, rightArrow, home, end, pageUp, pageDown
}

enum KeyModifier: String, CaseIterable, Equatable, Sendable {
  case shift, cmd, alt, ctrl
}

struct KeySpec: Equatable, Sendable {
  var key: KeyToken
  var modifiers: [KeyModifier]
}

/// USB HID keyboard-page usage id (what `key{usage}` carries, `KEY_USAGE` in the TS driver) -> `KeyToken`.
enum KeyMap {
  /// The wire `KeyName` names (`driver.types.ts`) -> key. Same names as `KeyboardMap.namedKeys` in warden-simd.
  static let namedKeys: [String: NamedKey] = [
    "Enter": .enter, "Return": .enter, "Escape": .escape, "Backspace": .delete, "Tab": .tab, "Space": .space,
    "Delete": .forwardDelete, "Home": .home, "PageUp": .pageUp, "End": .end, "PageDown": .pageDown,
    "Right": .rightArrow, "Left": .leftArrow, "Down": .downArrow, "Up": .upArrow,
  ]

  static let usageNames: [UInt32: NamedKey] = [
    0x28: .enter, 0x29: .escape, 0x2A: .delete, 0x2B: .tab, 0x2C: .space, 0x4A: .home, 0x4B: .pageUp,
    0x4C: .forwardDelete, 0x4D: .end, 0x4E: .pageDown, 0x4F: .rightArrow, 0x50: .leftArrow, 0x51: .downArrow,
    0x52: .upArrow,
  ]

  /// Keyboard-page usages: `a` is 0x04, `1`...`9` are 0x1E...0x26, `0` is 0x27, then `- = [ ] \ (non-US #) ; ' \` , . /`.
  static let characters: [UInt32: String] = {
    var table: [UInt32: String] = [:]
    for (offset, letter) in "abcdefghijklmnopqrstuvwxyz".enumerated() { table[0x04 + UInt32(offset)] = String(letter) }
    for (offset, digit) in "123456789".enumerated() { table[0x1E + UInt32(offset)] = String(digit) }
    table[0x27] = "0"
    let punctuation: [(UInt32, String)] = [
      (0x2D, "-"), (0x2E, "="), (0x2F, "["), (0x30, "]"), (0x31, "\\"), (0x33, ";"), (0x34, "'"), (0x35, "`"),
      (0x36, ","), (0x37, "."), (0x38, "/"),
    ]
    for (usage, character) in punctuation { table[usage] = character }
    return table
  }()

  /// Valid keyboard-page usages `a` (0x04) through Right GUI (0xE7), as in warden-simd.
  static let usageRange: ClosedRange<UInt32> = 0x04...0xE7

  /// `usage` wins over `name`. Modifier keys (0xE0...0xE7) and other usages XCUITest cannot press alone are
  /// `E_UNSUPPORTED`; an out-of-range usage or an unknown name is `E_BAD_REQUEST`.
  static func resolve(usage: Double?, name: String?, modifiers: [String]) -> Result<KeySpec, WireError> {
    var resolved: [KeyModifier] = []
    for entry in modifiers {
      guard let modifier = KeyModifier(rawValue: entry) else {
        return .failure(WireError(.badRequest, "unknown modifier \"\(entry)\""))
      }
      if !resolved.contains(modifier) { resolved.append(modifier) }
    }
    let token: KeyToken
    if let usage {
      guard usage.rounded() == usage, usage >= 0, usage <= 255, usageRange.contains(UInt32(usage)) else {
        return .failure(WireError(.badRequest, "\"usage\" must be a keyboard-page usage within 4...231, got \(usage)"))
      }
      let id = UInt32(usage)
      if let named = usageNames[id] {
        token = .named(named)
      } else if let character = characters[id] {
        token = .character(character)
      } else {
        return .failure(
          WireError(.unsupported, "usage \(id) cannot be pressed through XCUITest", detail: ["usage": .int(Int(id))]))
      }
    } else if let name {
      guard let named = namedKeys[name] else {
        return .failure(WireError(.badRequest, "unknown key name \"\(name)\""))
      }
      token = .named(named)
    } else {
      return .failure(WireError(.badRequest, "key needs \"usage\" or \"name\""))
    }
    return .success(KeySpec(key: token, modifiers: resolved))
  }
}
