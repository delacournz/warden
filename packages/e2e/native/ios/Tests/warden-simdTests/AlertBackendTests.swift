import FBSimulatorAX
import Foundation
import XCTest

@testable import warden_simd

/// `alertButtons{backend}` and `frontmost`: which readers an alert question asks, what a single reader answers, and the
/// pure parts of the frontmost probe. The documents are the live captures in `Fixtures` (see `SnapshotFixtureTests`).
final class AlertBackendTests: XCTestCase {
  private let screen = DocumentFixture.screen

  /// Scripts one document per reader and counts how often each was read; a missing entry is an absent reader (`nil`), an
  /// `Error` entry a failing one.
  private final class Readers: @unchecked Sendable {
    private let lock = NSLock()
    private var reads: [AXBackend: Int] = [:]
    private let answers: [AXBackend: Result<AccessibilityDocument, any Error>]

    init(_ answers: [AXBackend: Result<AccessibilityDocument, any Error>]) { self.answers = answers }

    func count(_ backend: AXBackend) -> Int { lock.withLock { reads[backend] ?? 0 } }

    func read(_ backend: AXBackend) throws -> AccessibilityDocument? {
      lock.withLock { reads[backend, default: 0] += 1 }
      return try answers[backend]?.get()
    }
  }

  private func answer(_ request: AlertRequest, _ readers: Readers) async throws -> JSON {
    try await Session.answerAlert(request, screen: screen) { try readers.read($0) }
  }

  private func buttons(_ alert: JSON) -> [String] {
    alert["buttons"]?.arrayValue?.compactMap { $0["label"]?.stringValue } ?? []
  }

  private var plain: AccessibilityDocument { get throws { try DocumentFixture.document("sign-in.document.json") } }
  private var hostAlert: AccessibilityDocument { get throws { try DocumentFixture.document("alert-host.document.json") } }
  private var bridgeAlert: AccessibilityDocument { get throws { try DocumentFixture.document("alert-bridge.document.json") } }
  private var keychain: AccessibilityDocument { get throws { try DocumentFixture.document("keychain-sheet.document.json") } }

  // MARK: request parsing

  func testNoBackendMeansBothReaders() throws {
    XCTAssertNil(try AlertRequest([:]).backend)
    XCTAssertNil(try AlertRequest(["backend": .null]).backend)
  }

  func testBackendIsAxOrAxbridge() throws {
    XCTAssertEqual(try AlertRequest(["backend": "ax"]).backend, .ax)
    XCTAssertEqual(try AlertRequest(["backend": "axbridge"]).backend, .axbridge)
  }

  func testAnyOtherBackendIsABadRequest() {
    XCTAssertThrowsError(try AlertRequest(["backend": "uiautomator"])) { error in
      XCTAssertEqual((error as? WireError)?.code, .badRequest)
    }
  }

  // MARK: one reader

  func testAxOnlyReadsOnlyTheHostReader() async throws {
    let readers = Readers([.ax: .success(try hostAlert), .axbridge: .success(try bridgeAlert)])
    let alert = try await answer(AlertRequest(backend: .ax), readers)
    XCTAssertEqual(buttons(alert), ["Allow Once", "Allow While Using App", "Don’t Allow"])
    XCTAssertEqual(readers.count(.ax), 1)
    XCTAssertEqual(readers.count(.axbridge), 0)
  }

  func testAxbridgeOnlyReadsOnlyTheBridge() async throws {
    let readers = Readers([.ax: .success(try plain), .axbridge: .success(try keychain)])
    let alert = try await answer(AlertRequest(backend: .axbridge), readers)
    XCTAssertEqual(buttons(alert), ["Not Now", "Save"])
    XCTAssertEqual(readers.count(.ax), 0)
    XCTAssertEqual(readers.count(.axbridge), 1)
  }

  func testAScreenWithoutAnAlertCostsOneReadOnAnExplicitBackend() async throws {
    for backend in [AXBackend.ax, .axbridge] {
      let readers = Readers([.ax: .success(try plain), .axbridge: .success(try plain)])
      let alert = try await answer(AlertRequest(backend: backend), readers)
      XCTAssertEqual(alert, .null)
      XCTAssertEqual(readers.count(.ax) + readers.count(.axbridge), 1)
    }
  }

  func testAnExplicitBackendThatFailsFailsTheOp() async throws {
    struct Down: Error {}
    let readers = Readers([.ax: .success(try plain), .axbridge: .failure(Down())])
    do {
      _ = try await answer(AlertRequest(backend: .axbridge), readers)
      XCTFail("expected the bridge failure to propagate")
    } catch is Down {
    }
  }

  func testAnExplicitBackendThatDoesNotExistIsUnavailable() async throws {
    let readers = Readers([.axbridge: .success(try plain)])
    do {
      _ = try await answer(AlertRequest(backend: .ax), readers)
      XCTFail("expected axUnavailable")
    } catch let error as WireError {
      XCTAssertEqual(error.code, .axUnavailable)
    }
  }

  // MARK: both readers (the default, unchanged)

  func testDefaultAsksTheHostReaderFirstAndStopsAtAnAlert() async throws {
    let readers = Readers([.ax: .success(try hostAlert), .axbridge: .success(try plain)])
    let alert = try await answer(AlertRequest(), readers)
    XCTAssertEqual(buttons(alert).count, 3)
    XCTAssertEqual(readers.count(.axbridge), 0)
  }

  func testDefaultFallsThroughToTheBridgeForAppOwnedPrompts() async throws {
    let readers = Readers([.ax: .success(try plain), .axbridge: .success(try keychain)])
    let alert = try await answer(AlertRequest(), readers)
    XCTAssertEqual(buttons(alert), ["Not Now", "Save"])
    XCTAssertEqual(readers.count(.ax), 1)
    XCTAssertEqual(readers.count(.axbridge), 1)
  }

  func testDefaultWithNoAlertReadsBothAndAnswersNull() async throws {
    let readers = Readers([.ax: .success(try plain), .axbridge: .success(try plain)])
    let alert = try await answer(AlertRequest(), readers)
    XCTAssertEqual(alert, .null)
    XCTAssertEqual(readers.count(.ax), 1)
    XCTAssertEqual(readers.count(.axbridge), 1)
  }

  func testDefaultOneReaderFailingIsNotAnErrorWhenTheOtherAnswers() async throws {
    struct Down: Error {}
    let readers = Readers([.ax: .failure(Down()), .axbridge: .success(try plain)])
    let alert = try await answer(AlertRequest(), readers)
    XCTAssertEqual(alert, .null)
  }

  func testDefaultBothFailingIsAnError() async throws {
    struct Down: Error {}
    let readers = Readers([.ax: .failure(Down()), .axbridge: .failure(Down())])
    do {
      _ = try await answer(AlertRequest(), readers)
      XCTFail("expected an error")
    } catch is Down {
    }
  }

  // MARK: frontmost

  func testFrontmostRequestNeedsABundleId() throws {
    XCTAssertEqual(try FrontmostRequest(["bundleId": "com.example.app"]).bundleId, "com.example.app")
    for params: JSON in [[:], ["bundleId": ""], ["bundleId": .null], ["bundleId": .int(3)]] {
      XCTAssertThrowsError(try FrontmostRequest(params)) { error in
        XCTAssertEqual((error as? WireError)?.code, .badRequest)
      }
    }
  }

  func testFrontmostIsTrueOnlyWhenTheBundleOwnsTheStreamsPid() {
    let yes = Session.frontmostReply(target: 42, frontmost: 42)
    XCTAssertEqual(yes["frontmost"], .bool(true))
    XCTAssertEqual(yes["pid"], .int(42))
    XCTAssertEqual(yes["frontmostPid"], .int(42))

    let other = Session.frontmostReply(target: 42, frontmost: 7)
    XCTAssertEqual(other["frontmost"], .bool(false))
    XCTAssertEqual(other["frontmostPid"], .int(7))
  }

  func testFrontmostIsFalseWhenEitherPidIsUnknown() {
    let notRunning = Session.frontmostReply(target: nil, frontmost: 7)
    XCTAssertEqual(notRunning["frontmost"], .bool(false))
    XCTAssertNil(notRunning["pid"])

    let noStream = Session.frontmostReply(target: 42, frontmost: nil)
    XCTAssertEqual(noStream["frontmost"], .bool(false))
    XCTAssertNil(noStream["frontmostPid"])

    XCTAssertEqual(Session.frontmostReply(target: nil, frontmost: nil)["frontmost"], .bool(false))
  }
}
