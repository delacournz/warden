import Foundation

/// How the runner types on a real device. One `typeText` call per character: XCUITest waits for the app to go idle
/// between calls, so a controlled React Native input commits each key before the next arrives. A whole string in one
/// call keeps the first character and drops the next few while the field re-renders.
enum Typing {
  static func pieces(_ text: String) -> [String] {
    text.map { String($0) }
  }
}

extension KeyMap {
  /// The `typeText` string for a key the software keyboard can type (iOS ignores `typeKey` without a hardware
  /// keyboard, so a Backspace there deleted nothing). nil: a modified or non-text key, pressed with `typeKey`.
  static func typedText(_ spec: KeySpec) -> String? {
    guard spec.modifiers.isEmpty else { return nil }
    switch spec.key {
    case let .character(character): return character
    case .named(.delete): return "\u{8}"
    case .named(.enter): return "\n"
    case .named(.tab): return "\t"
    case .named(.space): return " "
    case .named: return nil
    }
  }
}
