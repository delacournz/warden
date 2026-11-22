import Network
import XCTest

@testable import RunnerCore

/// A loopback client: connect, write lines, read lines. The server runs on its own queue, as it does in the runner (a
/// serial transport queue; ops go to the main thread through `WorkGate`).
private let testToken = String(repeating: "a1", count: 32)

/// An IPv4 address of this Mac that is not loopback (an up interface), if it has one.
private func nonLoopbackAddress() -> String? {
  var first: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&first) == 0 else { return nil }
  defer { freeifaddrs(first) }
  var cursor = first
  while let entry = cursor {
    defer { cursor = entry.pointee.ifa_next }
    let flags = Int32(entry.pointee.ifa_flags)
    guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0, let address = entry.pointee.ifa_addr,
      address.pointee.sa_family == sa_family_t(AF_INET)
    else { continue }
    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    let length = socklen_t(address.pointee.sa_len)
    if getnameinfo(address, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
      return String(cString: host)
    }
  }
  return nil
}

private final class Client {
  let connection: NWConnection
  private var buffer = LineBuffer()
  private(set) var lines: [JSON] = []
  private let lock = NSLock()
  private var ended = false
  private var connected = false
  var onLine: (() -> Void)?

  /// `token` is sent as the auth line the moment the connection is made; nil sends nothing.
  init(port: UInt16, queue: DispatchQueue, token: String? = testToken, host: String = "127.0.0.1") {
    connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready: self.lock.withLock { self.connected = true }
      case .failed, .cancelled: self.lock.withLock { self.ended = true }
      default: break
      }
    }
    connection.start(queue: queue)
    receive()
    if let token { write("{\"op\":\"auth\",\"token\":\"\(token)\"}\n") }
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
      if complete || error != nil {
        self.lock.withLock { self.ended = true }
      } else {
        self.receive()
      }
    }
  }

  func write(_ text: String) {
    connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
  }

  var count: Int { lock.withLock { lines.count } }
  /// The server hung up (or the connection failed).
  var isClosed: Bool { lock.withLock { ended } }
  var isConnected: Bool { lock.withLock { connected } }
  func line(_ index: Int) -> JSON { lock.withLock { lines[index] } }
}

final class RunnerServerTests: XCTestCase {
  private let queue = DispatchQueue(label: "runner-server-tests")
  private var server: RunnerServer!
  private var port: UInt16 = 0
  private var served: [String] = []

  private var extras: [RunnerServer] = []

  /// A listening server and its port.
  private func serve(loopbackOnly: Bool = true, authTimeout: TimeInterval = 5) async throws -> (RunnerServer, UInt16) {
    let server = RunnerServer(
      port: 0, queue: queue, token: testToken, loopbackOnly: loopbackOnly, authTimeout: authTimeout,
      readyFields: { RunnerInfo.readyFields(udid: "test-udid", screen: Fixture.screen, port: nil) },
      handle: { [unowned self] request in
        self.served.append(request.op)
        return .success(id: request.id, data: ["echo": .string(request.op)])
      })
    let listening = expectation(description: "listening")
    var bound: UInt16 = 0
    try server.start(
      onListening: {
        bound = $0
        listening.fulfill()
      }, onFailure: { XCTFail("listener failed: \($0)") })
    await fulfillment(of: [listening], timeout: 5)
    return (server, queue.sync { bound })
  }

  override func setUp() async throws {
    served = []
    (server, port) = try await serve()
  }

  override func tearDown() {
    server.stop()
    for extra in extras { extra.stop() }
    extras = []
  }

  private func waitUntil(_ timeout: TimeInterval = 5, _ condition: () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
  }

  // MARK: auth

  func testNothingIsSentBeforeTheAuthLine() async {
    let client = Client(port: port, queue: queue, token: nil)
    await waitUntil { client.isConnected }
    try? await Task.sleep(for: .milliseconds(200))
    XCTAssertEqual(client.count, 0)
    XCTAssertFalse(client.isClosed)
    client.write("{\"op\":\"auth\",\"token\":\"\(testToken)\"}\n")
    await waitForLines(client, 1)
    XCTAssertEqual(client.line(0)["event"], "ready")
  }

  func testAWrongTokenClosesTheConnectionWithNoBytes() async {
    let client = Client(port: port, queue: queue, token: String(repeating: "b2", count: 32))
    await waitUntil { client.isClosed }
    XCTAssertTrue(client.isClosed)
    XCTAssertEqual(client.count, 0)
  }

  func testAnOpBeforeAuthClosesTheConnectionUnhandled() async {
    let client = Client(port: port, queue: queue, token: nil)
    client.write("{\"id\":\"a\",\"op\":\"tap\"}\n{\"op\":\"auth\",\"token\":\"\(testToken)\"}\n")
    await waitUntil { client.isClosed }
    XCTAssertTrue(client.isClosed)
    XCTAssertEqual(client.count, 0)
    XCTAssertTrue(queue.sync { served }.isEmpty)
    XCTAssertEqual(server.served, 0)
  }

  func testAFirstLineThatNeverEndsClosesTheConnection() async {
    let client = Client(port: port, queue: queue, token: nil)
    client.write(String(repeating: "x", count: RunnerAuth.maxLineBytes + 1))
    await waitUntil { client.isClosed }
    XCTAssertTrue(client.isClosed)
    XCTAssertEqual(client.count, 0)
  }

  func testASilentConnectionIsClosedAfterTheAuthTimeout() async throws {
    let (quick, quickPort) = try await serve(authTimeout: 1)
    extras.append(quick)
    let silent = Client(port: quickPort, queue: queue, token: nil)
    let authed = Client(port: quickPort, queue: queue)
    await waitUntil { silent.isClosed }
    XCTAssertTrue(silent.isClosed)
    XCTAssertEqual(silent.count, 0)
    try? await Task.sleep(for: .milliseconds(200))
    XCTAssertFalse(authed.isClosed)
    authed.write("{\"id\":\"1\",\"op\":\"health\"}\n")
    await waitForLines(authed, 2)
    XCTAssertEqual(authed.line(1)["ok"], true)
  }

  func testTheAuthLineIsNotCountedAsARequest() async {
    let client = Client(port: port, queue: queue)
    await waitForLines(client, 1)
    XCTAssertEqual(server.served, 0)
  }

  func testAServerWithoutAUsableTokenDoesNotStart() {
    let server = RunnerServer(
      port: 0, queue: queue, token: "", loopbackOnly: true, readyFields: { [:] },
      handle: { .success(id: $0.id, data: [:]) })
    XCTAssertThrowsError(try server.start(onListening: { _ in }, onFailure: { _ in }))
  }

  func testTokenFromTheEnvironment() {
    XCTAssertEqual(RunnerAuth.token(in: ["WARDEN_RUNNER_TOKEN": testToken]), testToken)
    XCTAssertNil(RunnerAuth.token(in: [:]))
    XCTAssertNil(RunnerAuth.token(in: ["WARDEN_RUNNER_TOKEN": "short"]))
  }

  func testAcceptsOnlyTheAuthOpWithTheExactToken() {
    func line(_ text: String) -> Data { Data(text.utf8) }
    XCTAssertTrue(RunnerAuth.accepts(line: line("{\"op\":\"auth\",\"token\":\"\(testToken)\"}"), token: testToken))
    XCTAssertFalse(RunnerAuth.accepts(line: line("{\"op\":\"auth\",\"token\":\"\(testToken)0\"}"), token: testToken))
    XCTAssertFalse(RunnerAuth.accepts(line: line("{\"op\":\"auth\",\"token\":\"\(testToken.dropLast())\"}"), token: testToken))
    XCTAssertFalse(RunnerAuth.accepts(line: line("{\"op\":\"auth\",\"token\":\"\"}"), token: testToken))
    XCTAssertFalse(RunnerAuth.accepts(line: line("{\"op\":\"auth\"}"), token: testToken))
    XCTAssertFalse(RunnerAuth.accepts(line: line("{\"op\":\"health\",\"token\":\"\(testToken)\"}"), token: testToken))
    XCTAssertFalse(RunnerAuth.accepts(line: line("{\"op\":\"auth\",\"token\":7}"), token: testToken))
    XCTAssertFalse(RunnerAuth.accepts(line: line("\"\(testToken)\""), token: testToken))
    XCTAssertFalse(RunnerAuth.accepts(line: line("not json"), token: testToken))
  }

  func testSameBytes() {
    XCTAssertTrue(RunnerAuth.sameBytes([1, 2, 3], [1, 2, 3]))
    XCTAssertFalse(RunnerAuth.sameBytes([1, 2, 3], [1, 2, 4]))
    XCTAssertFalse(RunnerAuth.sameBytes([1, 2], [1, 2, 3]))
    XCTAssertFalse(RunnerAuth.sameBytes([1, 2, 3, 4], [1, 2, 3]))
    XCTAssertFalse(RunnerAuth.sameBytes([], [1]))
    XCTAssertTrue(RunnerAuth.sameBytes([], []))
  }

  // MARK: loopback

  func testALoopbackOnlyListenerIsNotReachableOnAnotherAddressOfThisMac() async throws {
    guard let address = nonLoopbackAddress() else { throw XCTSkip("this Mac has no non-loopback IPv4 address") }
    // the same address reaches a listener on every interface, so a refusal below is the listener's doing
    let (open, openPort) = try await serve(loopbackOnly: false)
    extras.append(open)
    let control = Client(port: openPort, queue: queue, host: address)
    await waitForLines(control, 1)
    guard control.count == 1 else { throw XCTSkip("\(address) does not reach a listener on this Mac") }

    let outside = Client(port: port, queue: queue, host: address)
    try? await Task.sleep(for: .milliseconds(500))
    XCTAssertFalse(outside.isConnected)
    XCTAssertEqual(outside.count, 0)

    let local = Client(port: port, queue: queue)
    await waitForLines(local, 1)
    XCTAssertEqual(local.line(0)["event"], "ready")
  }

  // MARK: serving

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
