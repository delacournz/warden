import XCTest

@testable import RunnerCore

final class TypingTests: XCTestCase {
  func testKeysWithATypedEquivalentGoThroughTypeText() {
    XCTAssertEqual(KeyMap.typedText(KeySpec(key: .named(.delete), modifiers: [])), "\u{8}")
    XCTAssertEqual(KeyMap.typedText(KeySpec(key: .named(.enter), modifiers: [])), "\n")
    XCTAssertEqual(KeyMap.typedText(KeySpec(key: .named(.tab), modifiers: [])), "\t")
    XCTAssertEqual(KeyMap.typedText(KeySpec(key: .named(.space), modifiers: [])), " ")
    XCTAssertEqual(KeyMap.typedText(KeySpec(key: .character("a"), modifiers: [])), "a")
  }

  func testModifiedOrNonTextKeysStayOnTypeKey() {
    XCTAssertNil(KeyMap.typedText(KeySpec(key: .named(.delete), modifiers: [.cmd])))
    XCTAssertNil(KeyMap.typedText(KeySpec(key: .character("a"), modifiers: [.cmd])))
    XCTAssertNil(KeyMap.typedText(KeySpec(key: .named(.leftArrow), modifiers: [])))
    XCTAssertNil(KeyMap.typedText(KeySpec(key: .named(.escape), modifiers: [])))
  }

  func testTextIsTypedOneCharacterAtATime() {
    XCTAssertEqual(Typing.pieces("Ada@E"), ["A", "d", "a", "@", "E"])
    XCTAssertEqual(Typing.pieces("héllo👍🏽"), ["h", "é", "l", "l", "o", "👍🏽"])
    XCTAssertEqual(Typing.pieces(""), [])
  }
}
