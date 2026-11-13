import Foundation

/// One issue of `performAccessibilityAudit`, reduced to what the wire carries. The XCTest glue fills it from
/// `XCUIAccessibilityAuditIssue`; tests build it by hand. `auditTypes` are the names of the audit-type bits the issue
/// carries (`AuditEncoder.knownTypes`), normally one.
struct RawAuditIssue: Equatable, Sendable {
  struct Element: Equatable, Sendable {
    var type: String
    var identifier: String
    var label: String
    /// Interface space, like `RawNode.frame`.
    var frame: Rect
  }

  var auditTypes: [String]
  var compactDescription: String
  var detailedDescription: String
  var element: Element?
}

/// `audit` op: the audit-type names, and the issues -> wire encoding (plan WDN-A11Y, A11Y-4). The names are
/// `XCUIAccessibilityAuditType` option names; the TS side maps them to WCAG success criteria.
enum AuditEncoder {
  static let knownTypes: [String] = [
    "contrast", "elementDetection", "hitRegion", "sufficientElementDescription", "dynamicType", "textClipped", "trait",
  ]

  /// Requested type names -> the validated list; `nil`/empty/`all` = every type. An unknown name is an error.
  static func resolveTypes(_ requested: [String]?) -> Result<[String], WireError> {
    guard let requested, !requested.isEmpty, !requested.contains("all") else { return .success(knownTypes) }
    if let unknown = requested.first(where: { !knownTypes.contains($0) }) {
      return .failure(
        WireError(
          .badRequest, "unknown audit type \"\(unknown)\"; use one of \(knownTypes.joined(separator: ", ")) or \"all\"",
          detail: ["type": .string(unknown)]))
    }
    return .success(knownTypes.filter(requested.contains))
  }

  /// The wire `data` of an `audit` op: `{issues:[…], count, types, ms}`. Frames are portrait-up like snapshots.
  static func auditData(issues: [RawAuditIssue], types: [String], space: FrameSpace, ms: Double) -> JSON {
    .object([
      "issues": .array(issues.map { issue($0, space: space) }),
      "count": .int(issues.count),
      "types": .array(types.map { .string($0) }),
      "ms": .double((ms * 10).rounded() / 10),
    ])
  }

  private static func issue(_ raw: RawAuditIssue, space: FrameSpace) -> JSON {
    var fields: [String: JSON] = [
      "auditType": .string(raw.auditTypes.first ?? "unknown"),
      "auditTypes": .array(raw.auditTypes.map { .string($0) }),
      "compactDescription": .string(raw.compactDescription),
      "detailedDescription": .string(raw.detailedDescription),
    ]
    if let element = raw.element {
      let frame = space.toPortrait(element.frame)
      fields["element"] = .object([
        "type": .string(element.type),
        "identifier": .string(element.identifier),
        "label": .string(element.label),
        "frame": .object([
          "x": .double(frame.x), "y": .double(frame.y), "width": .double(frame.width), "height": .double(frame.height),
        ]),
      ])
    }
    return .object(fields)
  }
}
