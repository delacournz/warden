import XCTest

@testable import RunnerCore

private final class FakeExecutor: CommandExecutor {
  var seen: [RunnerCommand] = []
  var reply: Result<JSON, WireError> = .success(["ok": true])

  func execute(_ command: RunnerCommand, op: String) -> Result<JSON, WireError> {
    seen.append(command)
    return reply
  }
}

final class RouterTests: XCTestCase {
  func testValidRequestReachesTheExecutorAndKeepsItsId() {
    let executor = FakeExecutor()
    let response = Router.respond(to: Fixture.request("health"), executor: executor)
    XCTAssertEqual(executor.seen, [.health])
    XCTAssertEqual(response, .success(id: "1", data: ["ok": true]))
  }

  func testInvalidRequestIsAnsweredWithoutTouchingTheDevice() {
    let executor = FakeExecutor()
    let response = Router.respond(to: Fixture.request("tap", ["x": 1]), executor: executor)
    XCTAssertTrue(executor.seen.isEmpty)
    guard case let .failure(id, error) = response else { return XCTFail("expected a failure") }
    XCTAssertEqual(id, "1")
    XCTAssertEqual(error.code, .badRequest)
  }

  func testUnsupportedOpNeverReachesTheExecutor() {
    let executor = FakeExecutor()
    let response = Router.respond(to: Fixture.request("pinch"), executor: executor)
    XCTAssertTrue(executor.seen.isEmpty)
    guard case let .failure(_, error) = response else { return XCTFail("expected a failure") }
    XCTAssertEqual(error.code, .unsupported)
  }

  func testExecutorErrorsBecomeFailures() {
    let executor = FakeExecutor()
    executor.reply = .failure(WireError(.noElement, "nothing focused"))
    let response = Router.respond(to: Fixture.request("typeText", ["text": "a"]), executor: executor)
    XCTAssertEqual(response, .failure(id: "1", error: WireError(.noElement, "nothing focused")))
  }
}
