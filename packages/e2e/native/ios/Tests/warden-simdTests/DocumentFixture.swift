import FBSimulatorAX
import Foundation
import XCTest

@testable import warden_simd

/// Loads idb `complete` documents captured from a real simulator (`snapshot{raw:true}`) back into
/// `AccessibilityDocument`s, and compares/regenerates the golden payloads the bun shape test validates.
enum DocumentFixture {
  static let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
  static let screen: (width: Double, height: Double, scale: Double) = (402, 874, 3)

  static func data(_ name: String) throws -> Data {
    try Data(contentsOf: directory.appendingPathComponent(name))
  }

  static func document(_ name: String) throws -> AccessibilityDocument {
    guard let root = try JSONSerialization.jsonObject(with: data(name)) as? [String: Any] else {
      throw FixtureError.malformed(name)
    }
    let elements = (root["elements"] as? [[String: Any]] ?? []).map(element)
    var modal: AccessibilityModalInfo?
    if let fields = root["modal"] as? [String: Any], let type = fields["element_type"] as? String ?? fields["elementType"] as? String {
      let kind = AccessibilityModalInfo.Kind(rawValue: fields["kind"] as? String ?? "system") ?? .system
      modal = AccessibilityModalInfo(kind: kind, elementType: type, label: fields["label"] as? String)
    }
    var info: AccessibilityScreenInfo?
    if let fields = root["screen"] as? [String: Any], let width = fields["width"] as? Double,
      let height = fields["height"] as? Double
    {
      info = AccessibilityScreenInfo(width: width, height: height)
    }
    return AccessibilityDocument(
      elements: elements, modal: modal, truncated: root["truncated"] as? Bool ?? false, screen: info)
  }

  /// One element of the `complete` encoding. A key that is present (even `null`) becomes `.some(...)`; an absent key
  /// stays unset, which is the distinction idb's doubly-optional fields carry.
  static func element(_ fields: [String: Any]) -> AccessibilityDocumentElement {
    var node = AccessibilityDocumentElement()
    func string(_ key: String) -> String?? {
      guard fields.keys.contains(key) else { return nil }
      return .some(fields[key] as? String)
    }
    func bool(_ key: String) -> Bool?? {
      guard fields.keys.contains(key) else { return nil }
      return .some(fields[key] as? Bool)
    }
    node.label = string("label")
    node.identifier = string("identifier")
    node.type = string("type")
    node.title = string("title")
    node.help = string("help")
    node.placeholder = string("placeholder")
    node.enabled = bool("enabled")
    node.hidden = bool("hidden")
    node.focused = bool("focused")
    if fields.keys.contains("value") { node.value = .some(AccessibilityAttributeValue(fields["value"])) }
    if fields.keys.contains("traits") { node.traits = .some(fields["traits"] as? [String]) }
    if fields.keys.contains("pid") { node.pid = .some((fields["pid"] as? NSNumber)?.int64Value) }
    if fields.keys.contains("frame") {
      let frame = fields["frame"] as? [String: Any]
      node.frame = .some(
        frame.map {
          AccessibilityFrame(
            x: ($0["x"] as? NSNumber)?.doubleValue, y: ($0["y"] as? NSNumber)?.doubleValue,
            width: ($0["width"] as? NSNumber)?.doubleValue, height: ($0["height"] as? NSNumber)?.doubleValue)
        })
    }
    node.children = (fields["children"] as? [[String: Any]])?.map(element)
    return node
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
