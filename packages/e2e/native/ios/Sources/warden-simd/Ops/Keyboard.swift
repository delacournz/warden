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

  static let letterA: UInt32 = 0x04
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

  /// One step of a paced key sequence. The helper yields each `.event` into idb's HID stream as it is reached and
  /// sleeps `.pause` milliseconds itself, so the whole sequence is still one HID operation (one drain at the end)
  /// while the delays are timed here instead of by idb's `.delay`.
  enum KeyStep: Equatable, Sendable {
    case event(SimulatorHIDEvent)
    case pause(Int)
  }

  /// What `typeText` will do with `text`: the steps for the longest mappable prefix and the untyped remainder.
  struct TypingPlan: Equatable, Sendable {
    /// Key events and pauses in order; empty when nothing mapped.
    let steps: [KeyStep]
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

  /// Quiet after each key press (`WARDEN_SIMD_PACE_MS`). Measured on a local simulator against the example app's
  /// controlled React Native input (strings typed through `native/scripts/smoke.ts --focus-types`): 5 ms lost no
  /// character in 90 strings, 0 ms lost 3 to 6 in 80. It was 30 ms (a React Native field digests ~45-50 ms per
  /// character, but not per key press: the hold already covers most of it).
  static let defaultPaceMs = envMs("WARDEN_SIMD_PACE_MS", fallback: 5)

  /// Pause between a key's down and its up (`WARDEN_SIMD_HOLD_MS`). 20 ms is the floor: 10 and 15 ms dropped the
  /// character after a shifted one ("Hllo") 1 string in 10 to 20, 20 ms and up lost none. It was 40 ms.
  static let defaultHoldMs = envMs("WARDEN_SIMD_HOLD_MS", fallback: 20)

  /// Extra pause before a key identical to the one just typed (`WARDEN_SIMD_REPEAT_GAP_MS`). The second "l" of
  /// "Hello" is the character that goes missing first when this is too short; 50 ms lost none with hold 20, the
  /// same loss showed at 5 and 10 ms of hold. It was 300 ms.
  static let defaultRepeatGapMs = envMs("WARDEN_SIMD_REPEAT_GAP_MS", fallback: 50)

  /// Extra pause between the first key of a `typeText` request and the second (`WARDEN_SIMD_LEAD_MS`). A controlled
  /// React Native input re-renders on its first change (placeholder gone, focus state), and the second key landing in
  /// that render is lost or moved to the end ("Hllo", "Hllo, World 123!e", "lol, World 123!H"). Measured with
  /// `native/scripts/smoke.ts --focus-types 80 --via type` on a host busy with other simulators: no lead-in lost 8 of
  /// 80 strings (2-4 of 40 on other runs), always in the first two characters; 60 ms lost none in 80 (~41 ms/char).
  /// Pace 20 also lost none but costs ~54 ms on every character; pace 10 still lost 1.
  static let defaultLeadMs = envMs("WARDEN_SIMD_LEAD_MS", fallback: 60)

  // History: pace 30 / hold 40 / repeat gap 300 cost ~99 ms per character on the same simulator (and ~260 ms on the
  // EAS VirtualMac, where idb's `.delay` timer sleeps were stretched); 5 / 20 / 50 costs ~38 ms. The delays are
  // slept by this helper with zero timer tolerance (`InputEnvironment.pause`), not by idb's `.delay`.


  /// `paceMs` is the pause after every key press, `holdMs` the pause between a key's down and up, `repeatGapMs` an
  /// extra pause before a key identical to the previous one, `leadMs` an extra pause between the first key and the
  /// second (all 0 = back to back).
  static func plan(
    typing text: String, paceMs: Int = 0, holdMs: Int = 0, repeatGapMs: Int = 0, leadMs: Int = 0
  ) -> TypingPlan {
    var steps: [KeyStep] = []
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
      if typed == 1, leadMs > 0 { steps.append(.pause(leadMs)) }
      if stroke.shift != shiftDown {
        steps.append(.event(.keyboard(direction: stroke.shift ? .down : .up, keyCode: leftShift)))
        shiftDown = stroke.shift
      }
      if let previous, previous == stroke, repeatGapMs > 0 { steps.append(.pause(repeatGapMs)) }
      previous = stroke
      steps.append(.event(.keyboard(direction: .down, keyCode: stroke.usage)))
      if holdMs > 0 { steps.append(.pause(holdMs)) }
      steps.append(.event(.keyboard(direction: .up, keyCode: stroke.usage)))
      if paceMs > 0 { steps.append(.pause(paceMs)) }
      typed += 1
    }
    if shiftDown { steps.append(.event(.keyboard(direction: .up, keyCode: leftShift))) }
    return TypingPlan(steps: steps, typedScalars: typed, rest: rest)
  }

  /// `modifiers` down in order, the key down, `holdMs`, up, then `modifiers` up in reverse, then `paceMs` of quiet so
  /// the next request cannot land on a text field still digesting this key.
  static func chordSteps(usage: UInt32, modifiers: [UInt32], paceMs: Int = 0, holdMs: Int = 0) -> [KeyStep] {
    var steps: [KeyStep] = modifiers.map { .event(.keyboard(direction: .down, keyCode: $0)) }
    steps.append(.event(.keyboard(direction: .down, keyCode: usage)))
    if holdMs > 0 { steps.append(.pause(holdMs)) }
    steps.append(.event(.keyboard(direction: .up, keyCode: usage)))
    steps.append(contentsOf: modifiers.reversed().map { .event(.keyboard(direction: .up, keyCode: $0)) })
    if paceMs > 0 { steps.append(.pause(paceMs)) }
    return steps
  }

  /// An unpaced chord as one composite (paste: nothing follows that needs a pause).
  static func chord(usage: UInt32, modifiers: [UInt32]) -> SimulatorHIDEvent {
    var events: [SimulatorHIDEvent] = modifiers.map { .keyboard(direction: .down, keyCode: $0) }
    events.append(.keyboard(direction: .down, keyCode: usage))
    events.append(.keyboard(direction: .up, keyCode: usage))
    events.append(contentsOf: modifiers.reversed().map { .keyboard(direction: .up, keyCode: $0) })
    return .composite(events)
  }

  /// Cmd+V.
  static var paste: SimulatorHIDEvent {
    chord(usage: letterV, modifiers: [leftCommand])
  }

  /// Cmd+A: selects the whole text of the focused field, so one Backspace empties it. `paceMs` / `holdMs` as in
  /// `chordSteps`: the `selectAll` op passes the key defaults so the selection lands before the Backspace that follows.
  static func selectAll(paceMs: Int = 0, holdMs: Int = 0) -> [KeyStep] {
    chordSteps(usage: letterA, modifiers: [leftCommand], paceMs: paceMs, holdMs: holdMs)
  }
}
