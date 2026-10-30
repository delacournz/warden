import XCTest

@testable import RunnerCore

final class KeyMapTests: XCTestCase {
  private func spec(usage: Double? = nil, name: String? = nil, modifiers: [String] = []) throws -> KeySpec {
    try KeyMap.resolve(usage: usage, name: name, modifiers: modifiers).get()
  }

  private func failure(usage: Double? = nil, name: String? = nil, modifiers: [String] = []) -> WireError? {
    if case let .failure(error) = KeyMap.resolve(usage: usage, name: name, modifiers: modifiers) { return error }
    return nil
  }

  func testNamedKeysCoverTheWireKeyNames() throws {
    let expected: [String: NamedKey] = [
      "Enter": .enter, "Return": .enter, "Escape": .escape, "Backspace": .delete, "Tab": .tab, "Space": .space,
      "Delete": .forwardDelete, "Home": .home, "PageUp": .pageUp, "End": .end, "PageDown": .pageDown,
      "Right": .rightArrow, "Left": .leftArrow, "Down": .downArrow, "Up": .upArrow,
    ]
    for (name, key) in expected { XCTAssertEqual(try spec(name: name).key, .named(key), name) }
  }

  func testUsageIdsMatchTheNames() throws {
    XCTAssertEqual(try spec(usage: 0x28).key, .named(.enter))
    XCTAssertEqual(try spec(usage: 0x2A).key, .named(.delete))
    XCTAssertEqual(try spec(usage: 0x4C).key, .named(.forwardDelete))
    XCTAssertEqual(try spec(usage: 0x52).key, .named(.upArrow))
    XCTAssertEqual(try spec(usage: 0x04).key, .character("a"))
    XCTAssertEqual(try spec(usage: 0x1D).key, .character("z"))
    XCTAssertEqual(try spec(usage: 0x1E).key, .character("1"))
    XCTAssertEqual(try spec(usage: 0x27).key, .character("0"))
    XCTAssertEqual(try spec(usage: 0x38).key, .character("/"))
  }

  func testEveryNamedKeyNameAndUsageAgree() {
    for (name, key) in KeyMap.namedKeys {
      // Every wire name with a usage in the shared table agrees with it (Return/Enter share 0x28).
      if let usage = KeyMap.usageNames.first(where: { $0.value == key })?.key {
        XCTAssertEqual(try? spec(usage: Double(usage)).key, .named(key), name)
      }
    }
  }

  func testModifiersAreKeptInOrderAndDeduplicated() throws {
    XCTAssertEqual(try spec(usage: 0x04, modifiers: ["cmd", "shift", "cmd"]).modifiers, [.cmd, .shift])
  }

  func testUsageWinsOverName() throws {
    XCTAssertEqual(try spec(usage: 0x04, name: "Enter").key, .character("a"))
  }

  func testBadInputs() {
    XCTAssertEqual(failure()?.code, .badRequest)
    XCTAssertEqual(failure(name: "Hyper")?.code, .badRequest)
    XCTAssertEqual(failure(usage: 3)?.code, .badRequest)
    XCTAssertEqual(failure(usage: 256)?.code, .badRequest)
    XCTAssertEqual(failure(usage: 4.5)?.code, .badRequest)
    XCTAssertEqual(failure(name: "Enter", modifiers: ["hyper"])?.code, .badRequest)
  }

  func testModifierUsagesAndUnmappedKeysAreUnsupported() {
    XCTAssertEqual(failure(usage: 0xE1)?.code, .unsupported)
    XCTAssertEqual(failure(usage: 0x39)?.code, .unsupported)
  }
}
