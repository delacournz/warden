import Foundation
import XCTest

@testable import warden_simd

/// Loads idb `complete` documents captured from a real simulator (`snapshot{raw:true}`) back into
/// `RawDocument`s, and compares/regenerates the golden payloads the bun shape test validates.
enum DocumentFixture {
  static let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
  static let screen: (width: Double, height: Double, scale: Double) = (402, 874, 3)

  static func data(_ name: String) throws -> Data {
    try Data(contentsOf: directory.appendingPathComponent(name))
  }

  static func document(_ name: String) throws -> RawDocument {
    guard let root = try JSONSerialization.jsonObject(with: data(name)) as? [String: Any] else {
      throw FixtureError.malformed(name)
    }
    let elements = (root["elements"] as? [[String: Any]] ?? []).map(element)
    var modal: RawModal?
    if let fields = root["modal"] as? [String: Any], let type = fields["element_type"] as? String ?? fields["elementType"] as? String {
      modal = RawModal(elementType: type, label: fields["label"] as? String)
    }
    var info: RawScreen?
    if let fields = root["screen"] as? [String: Any], let width = fields["width"] as? Double,
      let height = fields["height"] as? Double
    {
      info = RawScreen(width: width, height: height)
    }
    return RawDocument(elements: elements, modal: modal, truncated: root["truncated"] as? Bool ?? false, screen: info)
  }

  /// One element of the `complete` encoding. A `traits` key that is present (even `null`) is a reported field; the
  /// other attributes read the same whether absent or null.
  static func element(_ fields: [String: Any]) -> RawNode {
    var node = RawNode()
    node.label = fields["label"] as? String
    node.identifier = fields["identifier"] as? String
    node.type = fields["type"] as? String
    node.placeholder = fields["placeholder"] as? String
    node.enabled = fields["enabled"] as? Bool
    node.hidden = fields["hidden"] as? Bool
    node.focused = fields["focused"] as? Bool
    node.value = value(fields["value"])
    node.traitsReported = fields.keys.contains("traits")
    node.traits = fields["traits"] as? [String]
    node.pid = (fields["pid"] as? NSNumber)?.int64Value
    if let frame = fields["frame"] as? [String: Any] {
      node.frame = RawFrame(
        x: (frame["x"] as? NSNumber)?.doubleValue, y: (frame["y"] as? NSNumber)?.doubleValue,
        width: (frame["width"] as? NSNumber)?.doubleValue, height: (frame["height"] as? NSNumber)?.doubleValue)
    }
    node.children = (fields["children"] as? [[String: Any]])?.map(element)
    return node
  }

  private static func value(_ raw: Any?) -> RawValue? {
    guard let raw, !(raw is NSNull) else { return nil }
    if let text = raw as? String { return .string(text) }
    guard let number = raw as? NSNumber else { return .unsupported }
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
    return CFNumberIsFloatType(number) ? .double(number.doubleValue) : .int(number.int64Value)
  }

  // MARK: - Golden files

  /// `WARDEN_SIMD_UPDATE_GOLDEN=1 swift test` rewrites the goldens; otherwise they must match exactly. The bun test
  /// `native/scripts/element-shape.test.ts` parses the same files with the TS zod schemas.
  static func assertGolden(
    _ json: JSON, named name: String, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let produced = try encoder.encode(json)
    let url = directory.appendingPathComponent(name)
    if ProcessInfo.processInfo.environment["WARDEN_SIMD_UPDATE_GOLDEN"] == "1" {
      try produced.write(to: url)
      return
    }
    let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as AnyObject
    let actual = try JSONSerialization.jsonObject(with: produced) as AnyObject
    XCTAssertTrue(
      expected.isEqual(actual), "\(name) differs from the produced payload (WARDEN_SIMD_UPDATE_GOLDEN=1 regenerates)",
      file: file, line: line)
  }

  enum FixtureError: Error {
    case malformed(String)
  }
}
