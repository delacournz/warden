import Foundation
import XCTest

@testable import RunnerCore

/// Raw XCUITest trees (`*.raw.json`) and the payloads the runner builds from them (`*.golden.json`).
/// `WARDEN_RUNNER_UPDATE_GOLDEN=1 swift test` rewrites the goldens; `native/scripts/element-shape.test.ts` parses the
/// same files with the TS zod schemas the driver validates real helper output with.
enum Fixture {
  static let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")

  static let screen = RunnerInfo.Screen(width: 440, height: 956, scale: 3)

  static func raw(_ name: String) throws -> RawNode {
    try JSONDecoder().decode(RawNode.self, from: Data(contentsOf: directory.appendingPathComponent(name)))
  }

  static func assertGolden(
    _ json: JSON, named name: String, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    let produced = try encoder.encode(json)
    let url = directory.appendingPathComponent(name)
    if ProcessInfo.processInfo.environment["WARDEN_RUNNER_UPDATE_GOLDEN"] == "1" {
      try produced.write(to: url)
      return
    }
    let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as AnyObject
    let actual = try JSONSerialization.jsonObject(with: produced) as AnyObject
    XCTAssertTrue(
      expected.isEqual(actual), "\(name) differs from the produced payload (WARDEN_RUNNER_UPDATE_GOLDEN=1 regenerates)",
      file: file, line: line)
  }

  static func request(_ op: String, _ fields: [String: JSON] = [:]) -> Request {
    var object = fields
    object["id"] = "1"
    object["op"] = .string(op)
    return Request(id: "1", op: op, timeoutMs: nil, params: .object(object))
  }
}
