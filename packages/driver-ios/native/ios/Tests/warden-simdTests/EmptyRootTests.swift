import FBSimulatorAX
import Foundation
import XCTest

@testable import warden_simd

/// Hands out scripted documents in order (the last one repeats); records how often it was read.
private actor Script {
  private var documents: [AccessibilityDocument]
  private(set) var reads = 0
  init(_ documents: [AccessibilityDocument]) { self.documents = documents }
  func next() -> AccessibilityDocument {
    reads += 1
    return documents.count > 1 ? documents.removeFirst() : documents[0]
  }
}

private final class Lines: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String] = []
  func add(_ line: String) { lock.withLock { items.append(line) } }
  var all: [String] { lock.withLock { items } }
}

final class EmptyRootTests: XCTestCase {
  private func emptyRoot() -> AccessibilityDocument {
    var node = AccessibilityDocumentElement()
    node.type = .some("Application")
    node.frame = .some(AccessibilityFrame(x: 0, y: 0, width: 0, height: 0))
    node.children = []
    return AccessibilityDocument(elements: [node])
  }

  private func fullTree() throws -> AccessibilityDocument {
    try DocumentFixture.document("sign-in.snapshot.golden.json")
  }

  private func run(
    bridge: [AccessibilityDocument], host: [AccessibilityDocument]?, lines: Lines
  ) async throws -> (outcome: AXOutcome<AccessibilityDocument>, bridgeReads: Int, hostReads: Int) {
    let bridgeScript = Script(bridge)
    let hostScript = Script(host ?? [])
    var hostRead: (@Sendable () async throws -> AccessibilityDocument)?
    if host != nil { hostRead = { @Sendable in await hostScript.next() } }
    let outcome = try await Session.recoverFromEmptyRoot(
      first: AXOutcome(value: emptyRoot(), backend: .axbridge, fallback: nil), retryDelay: .milliseconds(1),
      bridgeRead: { await bridgeScript.next() }, hostRead: hostRead, sleep: { _ in }, log: { lines.add($0) })
    let bridgeReads = await bridgeScript.reads
    let hostReads = await hostScript.reads
    return (outcome, bridgeReads, hostReads)
  }

  func testEmptyRootIsDetectedOnlyForASingleAreaLessChildlessNode() throws {
    XCTAssertTrue(Session.isEmptyRoot(emptyRoot()))
    XCTAssertFalse(Session.isEmptyRoot(try fullTree()))
    XCTAssertFalse(Session.isEmptyRoot(AccessibilityDocument(elements: [])))
  }

  func testASecondBridgeReadThatRecoversIsUsedWithoutFallback() async throws {
    let lines = Lines()
    let result = try await run(bridge: [try fullTree()], host: [try fullTree()], lines: lines)
    XCTAssertEqual(result.outcome.backend, .axbridge)
    XCTAssertNil(result.outcome.fallback)
    XCTAssertEqual(result.bridgeReads, 1)
    XCTAssertEqual(result.hostReads, 0)
    XCTAssertEqual(lines.all.count, 1)
  }

  func testAStillEmptyBridgeFallsBackToTheHostReaderWithAReason() async throws {
    let lines = Lines()
    let result = try await run(bridge: [emptyRoot()], host: [try fullTree()], lines: lines)
    XCTAssertEqual(result.outcome.backend, .ax)
    XCTAssertEqual(result.outcome.fallback?.reason, "axbridge returned an empty tree")
    XCTAssertFalse(Session.isEmptyRoot(result.outcome.value))
    XCTAssertEqual(result.bridgeReads, 1)
    XCTAssertEqual(result.hostReads, 1)
    XCTAssertTrue(lines.all.contains { $0.contains("fallback") })
  }

  func testWithoutAHostReaderTheFirstAnswerIsKept() async throws {
    let lines = Lines()
    let result = try await run(bridge: [emptyRoot()], host: nil, lines: lines)
    XCTAssertEqual(result.outcome.backend, .axbridge)
    XCTAssertTrue(Session.isEmptyRoot(result.outcome.value))
  }
}
