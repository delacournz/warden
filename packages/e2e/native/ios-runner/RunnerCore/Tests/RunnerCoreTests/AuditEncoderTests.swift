import XCTest

@testable import RunnerCore

final class AuditEncoderTests: XCTestCase {
  private let portrait = FrameSpace(interface: .portrait, width: 440, height: 956)

  private let issue = RawAuditIssue(
    auditTypes: ["sufficientElementDescription"],
    compactDescription: "Label not human-readable",
    detailedDescription: "The accessibilityLabel of this RCTViewComponentView is not human-readable.",
    element: RawAuditIssue.Element(
      type: "Other", identifier: "email", label: "ada@example.com", frame: Rect(x: 20, y: 100, width: 300, height: 44)))

  func testEncodesTypeDescriptionsAndElement() throws {
    let data = AuditEncoder.auditData(issues: [issue], types: AuditEncoder.knownTypes, space: portrait, ms: 1984.26)
    XCTAssertEqual(data["count"], .int(1))
    XCTAssertEqual(data["ms"], .double(1984.3))
    let first = try XCTUnwrap(data["issues"]?.arrayValue?.first)
    XCTAssertEqual(first["auditType"], "sufficientElementDescription")
    XCTAssertEqual(first["compactDescription"], "Label not human-readable")
    XCTAssertEqual(first["detailedDescription"]?.stringValue?.hasPrefix("The accessibilityLabel"), true)
    XCTAssertEqual(first["element"]?["identifier"], "email")
    XCTAssertEqual(first["element"]?["label"], "ada@example.com")
    XCTAssertEqual(first["element"]?["type"], "Other")
    XCTAssertEqual(first["element"]?["frame"]?["width"], .double(300))
  }

  func testAnIssueWithoutAnElementOmitsIt() throws {
    var bare = issue
    bare.element = nil
    let data = AuditEncoder.auditData(issues: [bare], types: ["trait"], space: portrait, ms: 0)
    XCTAssertNil(data["issues"]?.arrayValue?.first?["element"])
  }

  func testNoIssuesIsAnEmptyList() {
    let data = AuditEncoder.auditData(issues: [], types: ["contrast"], space: portrait, ms: 5)
    XCTAssertEqual(data["issues"], .array([]))
    XCTAssertEqual(data["count"], .int(0))
  }

  func testFramesAreConvertedToPortraitUp() throws {
    let landscape = FrameSpace(interface: .landscapeLeft, width: 440, height: 956)
    let data = AuditEncoder.auditData(issues: [issue], types: ["trait"], space: landscape, ms: 0)
    let frame = try XCTUnwrap(data["issues"]?.arrayValue?.first?["element"]?["frame"])
    // interface (20,100,300x44) rotated: x = width - (y + h), y = x, w = h, h = w
    XCTAssertEqual(frame["x"], .double(440 - (100 + 44)))
    XCTAssertEqual(frame["y"], .double(20))
    XCTAssertEqual(frame["width"], .double(44))
    XCTAssertEqual(frame["height"], .double(300))
  }

  func testAnIssueWithTwoTypesLeadsWithTheFirst() throws {
    var both = issue
    both.auditTypes = ["contrast", "hitRegion"]
    let first = try XCTUnwrap(AuditEncoder.auditData(issues: [both], types: [], space: portrait, ms: 0)["issues"]?.arrayValue?.first)
    XCTAssertEqual(first["auditType"], "contrast")
    XCTAssertEqual(first["auditTypes"], .array(["contrast", "hitRegion"]))
  }

  func testResolveTypes() throws {
    XCTAssertEqual(try AuditEncoder.resolveTypes(nil).get(), AuditEncoder.knownTypes)
    XCTAssertEqual(try AuditEncoder.resolveTypes([]).get(), AuditEncoder.knownTypes)
    XCTAssertEqual(try AuditEncoder.resolveTypes(["all"]).get(), AuditEncoder.knownTypes)
    XCTAssertEqual(try AuditEncoder.resolveTypes(["trait", "contrast"]).get(), ["contrast", "trait"])
    guard case let .failure(error) = AuditEncoder.resolveTypes(["bogus"]) else { return XCTFail("expected a failure") }
    XCTAssertEqual(error.code, .badRequest)
  }
}

final class AuditCommandTests: XCTestCase {
  private func parse(_ fields: [String: JSON]) -> Result<RunnerCommand, WireError> {
    CommandParser.parse(Fixture.request("audit", fields))
  }

  func testAuditNeedsABundleId() {
    guard case let .failure(error) = parse([:]) else { return XCTFail("expected a failure") }
    XCTAssertEqual(error.code, .badRequest)
  }

  func testAuditDefaultsToEveryType() throws {
    XCTAssertEqual(
      try parse(["bundleId": "com.example"]).get(),
      .audit(AuditParams(bundleId: "com.example", types: AuditEncoder.knownTypes)))
  }

  func testAuditReadsTypes() throws {
    XCTAssertEqual(
      try parse(["bundleId": "com.example", "types": ["hitRegion"]]).get(),
      .audit(AuditParams(bundleId: "com.example", types: ["hitRegion"])))
  }

  func testAuditRejectsBadTypes() {
    for types: JSON in [.string("contrast"), ["contrast", 3], ["nope"]] {
      guard case let .failure(error) = parse(["bundleId": "com.example", "types": types]) else {
        return XCTFail("expected a failure for \(types)")
      }
      XCTAssertEqual(error.code, .badRequest)
    }
  }
}
