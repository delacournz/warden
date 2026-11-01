import Network
import XCTest

@testable import RunnerCore

/// A loopback client: connect, write lines, read lines. The server runs on its own queue, as it does on `.main` in the
/// runner.
private final class Client {
  let connection: NWConnection
  private var buffer = LineBuffer()
  private(set) var lines: [JSON] = []
  private let lock = NSLock()
  var onLine: (() -> Void)?

  init(port: UInt16, queue: DispatchQueue) {
    connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    connection.start(queue: queue)
    receive()
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
      guard let self else { return }
      if let data {
        for line in self.buffer.append(data) {
          if let json = try? JSONDecoder().decode(JSON.self, from: line) {
            self.lock.withLock { self.lines.append(json) }
            self.onLine?()
          }
        }
      }
      if !complete && error == nil { self.receive() }
    }
  }

  func write(_ text: String) {
    connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
  }

  var count: Int { lock.withLock { lines.count } }
  func line(_ index: Int) -> JSON { lock.withLock { lines[index] } }
}

final class RunnerServerTests: XCTestCase {
  private let queue = DispatchQueue(label: "runner-server-tests")
  private var server: RunnerServer!
  private var port: UInt16 = 0
  private var served: [String] = []

  override func setUp() async throws {
    served = []
    server = RunnerServer(
      port: 0, queue: queue,
      readyFields: { RunnerInfo.readyFields(udid: "test-udid", screen: Fixture.screen, port: nil) },
      handle: { [unowned self] request in
        self.served.append(request.op)
        return .success(id: request.id, data: ["echo": .string(request.op)])
      })
    let listening = expectation(description: "listening")
    try server.start(
      onListening: { [unowned self] bound in
        self.port = bound
        listening.fulfill()
      }, onFailure: { XCTFail("listener failed: \($0)") })
    await fulfillment(of: [listening], timeout: 5)
  }

  override func tearDown() {
    server.stop()
  }

  private func waitForLines(_ client: Client, _ count: Int) async {
    let deadline = Date().addingTimeInterval(5)
    while client.count < count, Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
  }

  func testAConnectionGetsTheReadyEventFirst() async {
    let client = Client(port: port, queue: queue)
    await waitForLines(client, 1)
    XCTAssertEqual(client.line(0)["event"], "ready")
    XCTAssertEqual(client.line(0)["engine"], "xcuitest")
    XCTAssertEqual(client.line(0)["udid"], "test-udid")
  }

  func testRequestsAreAnsweredInOrderAndSplitAcrossWrites() async {
    let client = Client(port: port, queue: queue)
    await waitForLines(client, 1)
    client.write(#"{"id":"a","op":"he"#)
    try? await Task.sleep(for: .milliseconds(50))
    client.write("alth\"}\n{\"id\":\"b\",\"op\":\"snapshot\"}\r\n")
    await waitForLines(client, 3)
    XCTAssertEqual(client.line(1), ["id": "a", "ok": true, "data": ["echo": "health"]])
    XCTAssertEqual(client.line(2), ["id": "b", "ok": true, "data": ["echo": "snapshot"]])
    XCTAssertEqual(served, ["health", "snapshot"])
  }

  func testMalformedLinesAreAnsweredWithABadRequest() async {
    let client = Client(port: port, queue: queue)
    await waitForLines(client, 1)
    client.write("not json\n{\"id\":\"x\"}\n")
    await waitForLines(client, 3)
    XCTAssertEqual(client.line(1)["ok"], false)
    XCTAssertEqual(client.line(1)["error"]?["code"], "E_BAD_REQUEST")
    XCTAssertEqual(client.line(2)["id"], "x")
    XCTAssertEqual(client.line(2)["error"]?["code"], "E_BAD_REQUEST")
    XCTAssertTrue(served.isEmpty)
  }

  func testShutdownIsAnsweredThenTheServerIsDone() async {
    let client = Client(port: port, queue: queue)
    await waitForLines(client, 1)
    client.write("{\"id\":\"s\",\"op\":\"shutdown\"}\n")
    await waitForLines(client, 2)
    XCTAssertEqual(client.line(1)["id"], "s")
    XCTAssertEqual(client.line(1)["ok"], true)
    let deadline = Date().addingTimeInterval(5)
    while !queue.sync(execute: { server.isDone }), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    XCTAssertTrue(queue.sync { server.isDone })
  }

  func testTwoConnectionsAreServedByTheSameHandler() async {
    let first = Client(port: port, queue: queue)
    let second = Client(port: port, queue: queue)
    await waitForLines(first, 1)
    await waitForLines(second, 1)
    first.write("{\"id\":\"1\",\"op\":\"one\"}\n")
    second.write("{\"id\":\"2\",\"op\":\"two\"}\n")
    await waitForLines(first, 2)
    await waitForLines(second, 2)
    XCTAssertEqual(first.line(1)["data"]?["echo"], "one")
    XCTAssertEqual(second.line(1)["data"]?["echo"], "two")
  }
}
