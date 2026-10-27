import FBSimulatorControl
import XCTest

@testable import warden_simd

final class KeyboardTests: XCTestCase {
  func testEveryPrintableASCIICharacterMaps() {
    for code in 0x20...0x7E {
      let scalar = Unicode.Scalar(UInt8(code))
      XCTAssertNotNil(KeyboardMap.stroke(for: scalar), "no stroke for \(scalar) (0x\(String(code, radix: 16)))")
    }
    XCTAssertNotNil(KeyboardMap.stroke(for: "\n"))
    XCTAssertNotNil(KeyboardMap.stroke(for: "\t"))
  }

  func testEveryStrokeIsAValidKeyboardUsage() {
    for (scalar, stroke) in KeyboardMap.strokes {
      XCTAssertTrue(KeyboardMap.usageRange.contains(stroke.usage), "\(scalar) -> \(stroke.usage)")
    }
  }

  func testNonASCIIDoesNotMap() {
    XCTAssertNil(KeyboardMap.stroke(for: "é"))
    XCTAssertNil(KeyboardMap.stroke(for: "😀"))
    XCTAssertNil(KeyboardMap.stroke(for: "\u{7F}"))
  }

  func testKnownUsages() {
    XCTAssertEqual(KeyboardMap.stroke(for: "a"), .init(usage: 0x04, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: "A"), .init(usage: 0x04, shift: true))
    XCTAssertEqual(KeyboardMap.stroke(for: "z"), .init(usage: 0x1D, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: "1"), .init(usage: 0x1E, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: "0"), .init(usage: 0x27, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: "!"), .init(usage: 0x1E, shift: true))
    XCTAssertEqual(KeyboardMap.stroke(for: ")"), .init(usage: 0x27, shift: true))
    XCTAssertEqual(KeyboardMap.stroke(for: " "), .init(usage: 0x2C, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: "\n"), .init(usage: 0x28, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: "\t"), .init(usage: 0x2B, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: ","), .init(usage: 0x36, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: "?"), .init(usage: 0x38, shift: true))
    XCTAssertEqual(KeyboardMap.stroke(for: "\\"), .init(usage: 0x31, shift: false))
    XCTAssertEqual(KeyboardMap.stroke(for: "|"), .init(usage: 0x31, shift: true))
    XCTAssertEqual(KeyboardMap.stroke(for: "\""), .init(usage: 0x34, shift: true))
  }

  func testPlanWrapsRunsOfShiftedCharactersInOneShift() {
    let plan = KeyboardMap.plan(typing: "Hi!")
    XCTAssertNil(plan.rest)
    XCTAssertEqual(plan.typedScalars, 3)
    XCTAssertEqual(
      plan.steps,
      [
        .event(.keyboard(direction: .down, keyCode: KeyboardMap.leftShift)),
        .event(.keyboard(direction: .down, keyCode: 0x0B)), .event(.keyboard(direction: .up, keyCode: 0x0B)),
        .event(.keyboard(direction: .up, keyCode: KeyboardMap.leftShift)),
        .event(.keyboard(direction: .down, keyCode: 0x0C)), .event(.keyboard(direction: .up, keyCode: 0x0C)),
        .event(.keyboard(direction: .down, keyCode: KeyboardMap.leftShift)),
        .event(.keyboard(direction: .down, keyCode: 0x1E)), .event(.keyboard(direction: .up, keyCode: 0x1E)),
        .event(.keyboard(direction: .up, keyCode: KeyboardMap.leftShift)),
      ])
  }

  func testPlanReleasesShiftAtTheEndAndKeepsItAcrossConsecutiveCaps() {
    let plan = KeyboardMap.plan(typing: "AB")
    let events = plan.steps.compactMap { step -> SimulatorHIDEvent? in
      if case .event(let event) = step { return event }
      return nil
    }
    XCTAssertEqual(events.first, .keyboard(direction: .down, keyCode: KeyboardMap.leftShift))
    XCTAssertEqual(events.last, .keyboard(direction: .up, keyCode: KeyboardMap.leftShift))
    XCTAssertEqual(events.filter { $0 == .keyboard(direction: .down, keyCode: KeyboardMap.leftShift) }.count, 1)
  }

  func testPlanStopsAtTheFirstUnmappableCharacterAndReturnsTheRest() {
    let plan = KeyboardMap.plan(typing: "caf\u{E9} au lait")
    XCTAssertEqual(plan.typedScalars, 3)
    XCTAssertEqual(plan.rest, "\u{E9} au lait")
    XCTAssertEqual(plan.steps.count, 6, "c, a, f only: one down and one up each")
  }

  func testPlanForOnlyUnmappableTextTypesNothing() {
    let plan = KeyboardMap.plan(typing: "é")
    XCTAssertTrue(plan.steps.isEmpty)
    XCTAssertEqual(plan.rest, "é")
    XCTAssertEqual(plan.typedScalars, 0)
  }

  func testEmptyTextIsANoOp() {
    let plan = KeyboardMap.plan(typing: "")
    XCTAssertTrue(plan.steps.isEmpty)
    XCTAssertNil(plan.rest)
  }

  /// Pauses are plain milliseconds between the key events, never idb `.delay`s: hold between down and up, pace after
  /// the up, the repeat gap before an identical key.
  func testPlanPutsHoldPaceAndRepeatGapBetweenTheKeyEvents() {
    let plan = KeyboardMap.plan(typing: "aa", paceMs: 5, holdMs: 20, repeatGapMs: 50)
    XCTAssertEqual(
      plan.steps,
      [
        .event(.keyboard(direction: .down, keyCode: 0x04)), .pause(20),
        .event(.keyboard(direction: .up, keyCode: 0x04)), .pause(5),
        .pause(50),
        .event(.keyboard(direction: .down, keyCode: 0x04)), .pause(20),
        .event(.keyboard(direction: .up, keyCode: 0x04)), .pause(5),
      ])
  }

  func testPlanWithZeroPacingHasNoPauses() {
    let plan = KeyboardMap.plan(typing: "aab")
    XCTAssertFalse(plan.steps.contains { if case .pause = $0 { true } else { false } })
  }

  func testChordPressesModifiersAroundTheKeyAndReleasesInReverse() {
    let chord = KeyboardMap.chord(
      usage: 0x04, modifiers: [KeyboardMap.leftCommand, KeyboardMap.leftShift])
    XCTAssertEqual(
      chord,
      .composite([
        .keyboard(direction: .down, keyCode: 0xE3),
        .keyboard(direction: .down, keyCode: 0xE1),
        .keyboard(direction: .down, keyCode: 0x04),
        .keyboard(direction: .up, keyCode: 0x04),
        .keyboard(direction: .up, keyCode: 0xE1),
        .keyboard(direction: .up, keyCode: 0xE3),
      ]))
  }

  func testPasteIsCmdV() {
    XCTAssertEqual(KeyboardMap.paste, KeyboardMap.chord(usage: 0x19, modifiers: [0xE3]))
  }

  func testSelectAllIsCmdA() {
    XCTAssertEqual(
      KeyboardMap.selectAll(),
      [
        .event(.keyboard(direction: .down, keyCode: 0xE3)),
        .event(.keyboard(direction: .down, keyCode: 0x04)),
        .event(.keyboard(direction: .up, keyCode: 0x04)),
        .event(.keyboard(direction: .up, keyCode: 0xE3)),
      ])
    XCTAssertEqual(
      KeyboardMap.selectAll(paceMs: 30, holdMs: 40),
      [
        .event(.keyboard(direction: .down, keyCode: 0xE3)),
        .event(.keyboard(direction: .down, keyCode: 0x04)), .pause(40),
        .event(.keyboard(direction: .up, keyCode: 0x04)),
        .event(.keyboard(direction: .up, keyCode: 0xE3)), .pause(30),
      ])
  }

  func testNamedKeysCoverTheTypeScriptKeyNames() {
    // Mirrors KeyName in packages/e2e/src/driver/driver.types.ts and KEY_USAGE in ios-driver.ts.
    let expected: [String: UInt32] = [
      "Enter": 0x28, "Escape": 0x29, "Backspace": 0x2A, "Tab": 0x2B, "Space": 0x2C, "Delete": 0x4C,
      "Right": 0x4F, "Left": 0x50, "Down": 0x51, "Up": 0x52,
    ]
    for (name, usage) in expected { XCTAssertEqual(KeyboardMap.namedKeys[name], usage, name) }
  }

  func testModifierNamesMatchTheWire() {
    XCTAssertEqual(KeyboardMap.modifierUsages["shift"], 0xE1)
    XCTAssertEqual(KeyboardMap.modifierUsages["cmd"], 0xE3)
    XCTAssertEqual(KeyboardMap.modifierUsages["alt"], 0xE2)
    XCTAssertEqual(KeyboardMap.modifierUsages["ctrl"], 0xE0)
  }
}
