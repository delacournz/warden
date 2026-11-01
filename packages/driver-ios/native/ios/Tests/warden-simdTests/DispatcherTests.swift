import XCTest

@testable import warden_simd

final class DispatcherTests: XCTestCase {
  private typealias TestDispatcher = Dispatcher<Int>

  private func request(_ op: String, id: String = "1", timeoutMs: Int? = nil) -> Request {
    var fields: [String: JSON] = ["id": .string(id), "op": .string(op)]
    if let timeoutMs { fields["timeoutMs"] = .int(timeoutMs) }
    return Request(id: id, op: op, timeoutMs: timeoutMs, params: .object(fields))
  }

  func testUnknownOpIsBadRequestWithTheRequestId() async {
    let dispatcher = TestDispatcher(handlers: [:])
    let response = await dispatcher.handle(request("nope", id: "abc"), context: 0)
    guard case let .failure(id, error) = response else { return XCTFail("expected failure") }
    XCTAssertEqual(id, "abc")
    XCTAssertEqual(error.code, .badRequest)
    XCTAssertTrue(error.message.contains("nope"))
  }

  func testHandlerResultAndContextArePassedThrough() async {
    let dispatcher = TestDispatcher(handlers: ["echo": { context, params in ["context": .int(context), "op": params["op"] ?? .null] }])
    let response = await dispatcher.handle(request("echo"), context: 5)
    XCTAssertEqual(response, .success(id: "1", data: ["context": 5, "op": "echo"]))
  }

  func testThrownErrorsGoThroughTheMapper() async {
    struct Boom: Error {}
    let dispatcher = TestDispatcher(handlers: [
      "wire": { _, _ in throw WireError(.noElement, "gone") },
      "boom": { _, _ in throw Boom() },
    ])
    guard case let .failure(_, wire) = await dispatcher.handle(request("wire"), context: 0) else {
      return XCTFail("expected failure")
    }
    XCTAssertEqual(wire.code, .noElement)
    guard case let .failure(_, boom) = await dispatcher.handle(request("boom"), context: 0) else {
      return XCTFail("expected failure")
    }
    XCTAssertEqual(boom.code, .internal)
  }

  func testTimeoutMsAnswersWithETimeoutAndCancelsTheHandler() async {
    let cancelled = expectation(description: "handler saw cancellation")
    let dispatcher = TestDispatcher(handlers: [
      "slow": { _, _ in
        do { try await Task.sleep(for: .seconds(30)) } catch { cancelled.fulfill() }
        return .null
      }
    ])
    let started = ContinuousClock.now
    let response = await dispatcher.handle(request("slow", timeoutMs: 50), context: 0)
    guard case let .failure(_, error) = response else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, .timeout)
    XCTAssertTrue(error.retryable)
    XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
    await fulfillment(of: [cancelled], timeout: 5)
  }

  func testFastHandlerBeatsItsTimeout() async {
    let dispatcher = TestDispatcher(handlers: ["fast": { _, _ in "done" }])
    let response = await dispatcher.handle(request("fast", timeoutMs: 5_000), context: 0)
    XCTAssertEqual(response, .success(id: "1", data: "done"))
  }

  func testServerAnswersEachLineAndStopsAfterShutdown() async {
    let lines = LockedLines()
    let output = OutputChannel { lines.append($0) }
    let dispatcher = TestDispatcher(handlers: [
      "echo": { _, _ in "hi" },
      TestDispatcher.shutdownOp: { _, _ in ["bye": true] },
    ])
    let server = StdioServer(dispatcher: dispatcher, context: 0, output: output)
    let input = AsyncStream<Data> { continuation in
      continuation.yield(Data("{\"id\":\"1\",\"op\":\"echo\"}\nnot json\n".utf8))
      continuation.yield(Data("{\"id\":\"2\",\"op\":\"shutdown\"}\n".utf8))
      // Stream intentionally left open: shutdown has to end the loop.
    }
    let code = await server.run(input: input)
    XCTAssertEqual(code, 0)
    let decoded = lines.all.compactMap { try? JSONDecoder().decode(JSON.self, from: $0) }
    XCTAssertEqual(decoded.count, 3)
    XCTAssertTrue(decoded.contains(["id": "1", "ok": true, "data": "hi"]))
    XCTAssertTrue(decoded.contains(["id": "2", "ok": true, "data": ["bye": true]]))
    XCTAssertTrue(decoded.contains { $0["error"]?["code"] == "E_BAD_REQUEST" && $0["id"] == .null })
  }
}

private final class LockedLines: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [Data] = []

  func append(_ data: Data) { lock.withLock { storage.append(data) } }
  var all: [Data] { lock.withLock { storage } }
}
