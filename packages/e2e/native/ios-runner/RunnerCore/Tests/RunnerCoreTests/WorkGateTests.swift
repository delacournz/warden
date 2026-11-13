import XCTest

@testable import RunnerCore

/// `WorkGate`: XCUITest work runs on one queue (main in the runner) under a deadline, called from the transport queue.
/// A wedged op answers `E_TIMEOUT`, and until it returns every other op answers `E_TIMEOUT` (`stage: busy`) at once.
final class WorkGateTests: XCTestCase {
  private let work = DispatchQueue(label: "work-gate-tests.work")

  private func request(_ op: String, id: String = "1", timeoutMs: Int? = nil) -> Request {
    Request(id: id, op: op, timeoutMs: timeoutMs, params: ["id": .string(id), "op": .string(op)])
  }

  private func ok(_ request: Request) -> Response { .success(id: request.id, data: ["op": .string(request.op)]) }

  private func health(state: String, busy: JSON?) -> JSON {
    var fields: [String: JSON] = ["state": .string(state)]
    if let busy { fields["busy"] = busy }
    return .object(fields)
  }

  func testBudgetLeavesTheClientRoomToHearTheVerdict() {
    XCTAssertEqual(WorkGate.budgetMs(requestTimeoutMs: nil), WorkGate.defaultBudgetMs)
    XCTAssertEqual(WorkGate.budgetMs(requestTimeoutMs: 10_000), 9_500)
    XCTAssertEqual(WorkGate.budgetMs(requestTimeoutMs: 600), 300)
  }

  func testAnOpThatFinishesInTimeIsAnswered() {
    let gate = WorkGate(work: work)
    let r = request("tap")
    let response = gate.respond(to: r, health: health) { self.ok($0) }
    XCTAssertEqual(response, ok(r))
    XCTAssertNil(gate.busy)
  }

  func testAWedgedOpTimesOutThenTheGateIsBusyUntilItReturns() {
    let gate = WorkGate(work: work)
    let release = DispatchSemaphore(value: 0)
    let wedged = gate.respond(to: request("tap", id: "a", timeoutMs: 120), health: health) { r in
      release.wait()
      return self.ok(r)
    }
    guard case let .failure(id, error) = wedged else { return XCTFail("expected a failure, got \(wedged)") }
    XCTAssertEqual(id, "a")
    XCTAssertEqual(error.code, .timeout)
    XCTAssertTrue(error.retryable)
    XCTAssertEqual(error.detail?["stage"], "deadline")
    XCTAssertEqual(error.detail?["op"], "tap")
    XCTAssertEqual(gate.busy?.op, "tap")

    let ran = Flag()
    let refused = gate.respond(to: request("snapshot", id: "b"), health: health) { r in
      ran.set()
      return self.ok(r)
    }
    guard case let .failure(_, busy) = refused else { return XCTFail("expected busy, got \(refused)") }
    XCTAssertFalse(ran.value)
    XCTAssertEqual(busy.code, .timeout)
    XCTAssertTrue(busy.retryable)
    XCTAssertEqual(busy.detail?["stage"], "busy")
    XCTAssertEqual(busy.detail?["busyOp"], "tap")

    let status = gate.respond(to: request("health", id: "h"), health: health) { self.ok($0) }
    guard case let .success(_, data) = status else { return XCTFail("health must answer while busy") }
    XCTAssertEqual(data["state"], "busy")
    XCTAssertEqual(data["busy"]?["op"], "tap")

    release.signal()
    work.sync {}
    XCTAssertNil(gate.busy)
    let next = request("snapshot", id: "c")
    XCTAssertEqual(gate.respond(to: next, health: health) { self.ok($0) }, ok(next))
  }

  func testShutdownIsAnsweredWhileBusy() {
    let gate = WorkGate(work: work)
    let release = DispatchSemaphore(value: 0)
    _ = gate.respond(to: request("tap", timeoutMs: 100), health: health) { r in
      release.wait()
      return self.ok(r)
    }
    let shutdown = request("shutdown", id: "s")
    XCTAssertEqual(gate.respond(to: shutdown, health: health) { self.ok($0) }, .success(id: "s", data: [:]))
    release.signal()
    work.sync {}
  }

  func testHealthGoesThroughTheWorkQueueWhenIdle() {
    let gate = WorkGate(work: work)
    let r = request("health")
    XCTAssertEqual(gate.respond(to: r, health: health) { self.ok($0) }, ok(r))
  }
}

private final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var raised = false
  func set() { lock.withLock { raised = true } }
  var value: Bool { lock.withLock { raised } }
}
