import CoreGraphics
import XCTest

@testable import RunnerCore

/// XCUITest can report `CGRect.null` (origin at +infinity) or an infinite frame for an element it cannot place. One such
/// node must never fail the whole `snapshot` encode, and the wire must stay plain finite JSON numbers.
final class FiniteTests: XCTestCase {
  private let portrait = FrameSpace(interface: .portrait, width: 440, height: 956)

  private func rect(_ cg: CGRect) -> Rect {
    Rect(x: cg.minX, y: cg.minY, width: cg.width, height: cg.height)
  }

  private func decoded(_ json: JSON) throws -> JSON {
    let line = NDJSON.encodeLine(json)
    return try JSONDecoder().decode(JSON.self, from: line)
  }

  func testNonFiniteDoublesEncodeAsNullNotAFailedLine() throws {
    let back = try decoded(["nan": .double(.nan), "inf": .double(.infinity), "ok": .double(2.5)])
    XCTAssertEqual(back["nan"], .null)
    XCTAssertEqual(back["inf"], .null)
    XCTAssertEqual(back["ok"], .double(2.5))
    XCTAssertNil(back["error"])
  }

  func testNonFiniteRectIsZero() {
    XCTAssertEqual(rect(.null).finiteOrZero, .zero)
    XCTAssertEqual(rect(.infinite).finiteOrZero, .zero)
    let real = Rect(x: 1, y: 2, width: 3, height: 4)
    XCTAssertEqual(real.finiteOrZero, real)
  }

  func testNullAndInfiniteFramesEncodeAsZeroAreaNodes() throws {
    let root = RawNode(
      type: "Application", label: "App", frame: Rect(x: 0, y: 0, width: 440, height: 956),
      children: [
        RawNode(type: "StaticText", label: "lost", identifier: "lost", frame: rect(.null)),
        RawNode(type: "Other", identifier: "huge", frame: rect(.infinite)),
        RawNode(type: "Button", label: "Go", identifier: "go", frame: Rect(x: 10, y: 20, width: 100, height: 40)),
      ])
    let output = SnapshotEncoder.build(root: root, space: portrait)
    let data = SnapshotEncoder.snapshotData(output, screen: Fixture.screen, ms: 1)
    let back = try decoded(Response.success(id: "1", data: data).json)
    XCTAssertEqual(back["ok"], .bool(true))
    let nodes = output.elements.flatMap(\.preorder)
    let lost = try XCTUnwrap(nodes.first { $0.identifier == "lost" })
    XCTAssertEqual(lost.frame, .zero)
    XCTAssertEqual(lost.normFrame, .zero)
    XCTAssertEqual(lost.hittable, false)
    XCTAssertNil(lost.tapPoint)
    XCTAssertEqual(try XCTUnwrap(nodes.first { $0.identifier == "huge" }).frame, .zero)
    XCTAssertEqual(try XCTUnwrap(nodes.first { $0.identifier == "go" }).tapPoint, Point(x: 60, y: 40))
  }

  func testANonFiniteRootFrameResolvesToAnEmptySpace() {
    let space = FrameSpace.resolve(device: .portrait, rootFrame: rect(.null))
    XCTAssertEqual(space.width, 0)
    XCTAssertEqual(space.height, 0)
  }
}
