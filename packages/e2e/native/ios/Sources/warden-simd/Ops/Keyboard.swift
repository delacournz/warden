import FBSimulatorControl
import Foundation

/// USB HID keyboard-page (0x07) usages for the keys the helper types, plus the ASCII → keystroke map `typeText` uses.
/// idb's `.keyboard(direction:keyCode:)` takes the usage id as `keyCode`. Pure data + builders: no simulator needed.
enum KeyboardMap {
  /// One key press: the usage and whether Shift is held for it.
  struct Stroke: Equatable, Sendable {
    let usage: UInt32
    let shift: Bool
  }

  static let leftControl: UInt32 = 0xE0
  static let leftShift: UInt32 = 0xE1
  static let leftAlt: UInt32 = 0xE2
  static let leftCommand: UInt32 = 0xE3

  static let letterV: UInt32 = 0x19

  /// Valid keyboard-page usages: `a` (0x04) through Right GUI (0xE7).
  static let usageRange: ClosedRange<UInt32> = 0x04...0xE7

  /// The wire `Modifier` names (`driver.types.ts`) → modifier-key usage.
  static let modifierUsages: [String: UInt32] = [
    "shift": leftShift, "cmd": leftCommand, "alt": leftAlt, "ctrl": leftControl,
  ]

  /// The wire `KeyName` names (`driver.types.ts`) plus a few extra navigation keys → usage. `Delete` is
  /// Forward Delete (0x4C) like the TS `KEY_USAGE`; `Backspace` is 0x2A.
  static let namedKeys: [String: UInt32] = [
    "Enter": 0x28, "Return": 0x28, "Escape": 0x29, "Backspace": 0x2A, "Tab": 0x2B, "Space": 0x2C,
    "Delete": 0x4C, "Home": 0x4A, "PageUp": 0x4B, "End": 0x4D, "PageDown": 0x4E,
    "Right": 0x4F, "Left": 0x50, "Down": 0x51, "Up": 0x52,
  ]

  /// Every printable ASCII character (0x20...0x7E) plus `\n`, `\r` (Enter) and `\t` (Tab).
  static let strokes: [Unicode.Scalar: Stroke] = {
    var table: [Unicode.Scalar: Stroke] = [:]
    func add(_ character: Character, _ usage: UInt32, shift: Bool) {
      for scalar in character.unicodeScalars { table[scalar] = Stroke(usage: usage, shift: shift) }
    }
    for (offset, letter) in "abcdefghijklmnopqrstuvwxyz".enumerated() {
      add(letter, 0x04 + UInt32(offset), shift: false)
      add(Character(letter.uppercased()), 0x04 + UInt32(offset), shift: true)
    }
    // 1...9 are 0x1E...0x26, 0 is 0x27; the shifted row on a US layout is !@#$%^&*(  then )
    let shiftedDigits = Array("!@#$%^&*()")
    for (offset, digit) in "1234567890".enumerated() {
      add(digit, 0x1E + UInt32(offset), shift: false)
      add(shiftedDigits[offset], 0x1E + UInt32(offset), shift: true)
    }
    let plain = Array(#"-=[]\;'`,./"#)
    let shifted = Array(#"_+{}|:"~<>?"#)
    let usages: [UInt32] = [0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38]
    for (offset, usage) in usages.enumerated() {
      add(plain[offset], usage, shift: false)
      add(shifted[offset], usage, shift: true)
    }
    add(" ", 0x2C, shift: false)
    add("\t", 0x2B, shift: false)
    table["\n"] = Stroke(usage: 0x28, shift: false)
    table["\r"] = Stroke(usage: 0x28, shift: false)
    return table
  }()

  static func stroke(for scalar: Unicode.Scalar) -> Stroke? {
    strokes[scalar]
  }

  /// What `typeText` will do with `text`: the events for the longest mappable prefix and the untyped remainder.
  struct TypingPlan: Equatable, Sendable {
    /// One composite event, so the whole prefix is sent as a single HID operation.
    let event: SimulatorHIDEvent?
    let typedScalars: Int
    /// The text from the first unmappable scalar on; nil when everything mapped.
    let rest: String?
  }

  /// Reads a millisecond override (0...1000) from the environment, else `fallback`.
  private static func envMs(_ name: String, fallback: Int) -> Int {
    guard let raw = ProcessInfo.processInfo.environment[name], let ms = Int(raw), (0...1000).contains(ms) else {
      return fallback
    }
    return ms
  }

  /// Quiet after each key press (`WARDEN_SIMD_PACE_MS`). A React Native text field digests about 45-50 ms per
  /// character: unpaced strings arrived as "ada@example".
  static let defaultPaceMs = envMs("WARDEN_SIMD_PACE_MS", fallback: 30)

  /// Pause between a key's down and its up (`WARDEN_SIMD_HOLD_MS`). Back-to-back down/up drops keys: with 0 ms
  /// about 1 in 4 strings lost a character, 30 ms cut that to about 1 in 16.
  static let defaultHoldMs = envMs("WARDEN_SIMD_HOLD_MS", fallback: 40)

  /// Extra pause before a key identical to the one just typed (`WARDEN_SIMD_REPEAT_GAP_MS`). The second "l" of
  /// "Hello" was the remaining loss: hold 30 + gap 150 lost it 1 in 20 strings, hold 40 + gap 300 0 in 25.
  static let defaultRepeatGapMs = envMs("WARDEN_SIMD_REPEAT_GAP_MS", fallback: 300)

  /// `paceMs` is the pause after every key press, `holdMs` the pause between a key's down and up, `repeatGapMs` an
  /// extra pause before a key identical to the previous one (all 0 = back to back).
  static func plan(typing text: String, paceMs: Int = 0, holdMs: Int = 0, repeatGapMs: Int = 0) -> TypingPlan {
    var events: [SimulatorHIDEvent] = []
    var shiftDown = false
    var previous: Stroke?
    var typed = 0
    var rest: String?
    let scalars = Array(text.unicodeScalars)
    for (index, scalar) in scalars.enumerated() {
      guard let stroke = stroke(for: scalar) else {
        var remainder = String.UnicodeScalarView()
        remainder.append(contentsOf: scalars[index...])
        rest = String(remainder)
        break
      }
      if stroke.shift != shiftDown {
        events.append(.keyboard(direction: stroke.shift ? .down : .up, keyCode: leftShift))
        shiftDown = stroke.shift
      }
      if let previous, previous == stroke, repeatGapMs > 0 { events.append(.delay(Double(repeatGapMs) / 1000)) }
      previous = stroke
      events.append(.keyboard(direction: .down, keyCode: stroke.usage))
      if holdMs > 0 { events.append(.delay(Double(holdMs) / 1000)) }
      events.append(.keyboard(direction: .up, keyCode: stroke.usage))
      if paceMs > 0 { events.append(.delay(Double(paceMs) / 1000)) }
      typed += 1
    }
    if shiftDown { events.append(.keyboard(direction: .up, keyCode: leftShift)) }
    return TypingPlan(event: events.isEmpty ? nil : .composite(events), typedScalars: typed, rest: rest)
  }

  /// `modifiers` down in order, the key down, `holdMs`, up, then `modifiers` up in reverse, then `paceMs` of quiet so
  /// the next request cannot land on a text field still digesting this key.
  static func chord(usage: UInt32, modifiers: [UInt32], paceMs: Int = 0, holdMs: Int = 0) -> SimulatorHIDEvent {
    var events: [SimulatorHIDEvent] = modifiers.map { .keyboard(direction: .down, keyCode: $0) }
    events.append(.keyboard(direction: .down, keyCode: usage))
    if holdMs > 0 { events.append(.delay(Double(holdMs) / 1000)) }
    events.append(.keyboard(direction: .up, keyCode: usage))
    events.append(contentsOf: modifiers.reversed().map { .keyboard(direction: .up, keyCode: $0) })
    if paceMs > 0 { events.append(.delay(Double(paceMs) / 1000)) }
    return .composite(events)
  }

  /// Cmd+V.
  static var paste: SimulatorHIDEvent {
    chord(usage: letterV, modifiers: [leftCommand])
  }
}
