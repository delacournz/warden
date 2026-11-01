import Darwin
import XCTest

@testable import warden_simd

/// A blocking line client over a unix socket fd, with per-read deadlines so a bug fails the test instead of hanging it.
private final class TestClient {
  let fd: Int32
  private var buffer = LineBuffer()
  private var pending: [Data] = []

  init?(path: String) {
    guard let fd = UnixSocket.connect(path: path) else { return nil }
    self.fd = fd
  }

  func send(_ text: String) {
    let bytes = Array((text + "\n").utf8)
    _ = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
  }

  func readJSON(timeout: TimeInterval = 5) -> JSON? {
    let deadline = Date().addingTimeInterval(timeout)
    while pending.isEmpty {
      let remaining = Int32(max(0, deadline.timeIntervalSinceNow * 1000))
      var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      guard poll(&descriptor, 1, remaining) > 0 else { return nil }
      var bytes = [UInt8](repeating: 0, count: 4096)
      let count = read(fd, &bytes, bytes.count)
      if count <= 0 { return nil }
      pending.append(contentsOf: buffer.append(Data(bytes[0..<count])))
    }
    return try? JSONDecoder().decode(JSON.self, from: pending.removeFirst())
  }

  func close() { Darwin.close(fd) }
}

final class SocketServerTests: XCTestCase {
  private var path = ""

  override func setUp() {
    path = "/tmp/wsd-\(UUID().uuidString.prefix(8)).sock"
  }

  override func tearDown() {
    unlink(path)
  }

  private func makeServer(
    idle: IdleTracker = IdleTracker(timeout: 0), handlers: [String: Dispatcher<Int>.OpHandler] = [:]
  ) -> SocketServer<Int> {
    var table: [String: Dispatcher<Int>.OpHandler] = [
      "echo": { _, params in params["value"] ?? .null },
      Dispatcher<Int>.shutdownOp: { _, _ in ["bye": true] },
    ]
    table.merge(handlers) { _, new in new }
    return SocketServer(
      path: path, dispatcher: Dispatcher(handlers: table), context: 0, tracker: idle,
      ready: { ["protocol": 1, "udid": "U"] }, pollInterval: 0.02)
  }

  func testSocketIsOwnerOnly() throws {
    let server = makeServer()
    try server.start()
    defer { server.stop() }
    var info = stat()
    XCTAssertEqual(stat(path, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o600)
  }

  func testEveryConnectionGetsItsOwnReadyEvent() throws {
    let server = makeServer()
    try server.start()
    defer { server.stop() }
    let a = try XCTUnwrap(TestClient(path: path))
    let b = try XCTUnwrap(TestClient(path: path))
    defer {
      a.close()
      b.close()
    }
    for client in [a, b] {
      let ready = client.readJSON()
      XCTAssertEqual(ready?["event"], "ready")
      XCTAssertEqual(ready?["protocol"], 1)
    }
  }

  func testTwoConcurrentClientsCanBothUseTheSameRequestId() async throws {
    let started = expectation(description: "both handlers running")
    started.expectedFulfillmentCount = 2
    let (gate, release) = AsyncStream<Void>.makeStream()
    let tracker = IdleTracker(timeout: 0)
    let server = makeServer(
      idle: tracker,
      handlers: [
        "hold": { _, params in
          started.fulfill()
          for await _ in gate { break }
          return params["value"] ?? .null
        }
      ])
    try server.start()
    defer { server.stop() }
    let a = try XCTUnwrap(TestClient(path: path))
    let b = try XCTUnwrap(TestClient(path: path))
    defer {
      a.close()
      b.close()
    }
    _ = a.readJSON()
    _ = b.readJSON()
    a.send(#"{"id":"1","op":"hold","value":"from-a"}"#)
    b.send(#"{"id":"1","op":"hold","value":"from-b"}"#)
    await fulfillment(of: [started], timeout: 5)
    // Same wire id, two distinct internal keys.
    XCTAssertEqual(tracker.inflightCount, 2)
    XCTAssertEqual(tracker.clientCount, 2)
    release.yield(())
    release.yield(())
    XCTAssertEqual(a.readJSON(), ["id": "1", "ok": true, "data": "from-a"])
    XCTAssertEqual(b.readJSON(), ["id": "1", "ok": true, "data": "from-b"])
    XCTAssertEqual(tracker.inflightCount, 0)
  }

  func testRequestsAreAnsweredOnTheirOwnConnection() throws {
    let server = makeServer()
    try server.start()
    defer { server.stop() }
    let a = try XCTUnwrap(TestClient(path: path))
    let b = try XCTUnwrap(TestClient(path: path))
    defer {
      a.close()
      b.close()
    }
    _ = a.readJSON()
    _ = b.readJSON()
    a.send(#"{"id":"1","op":"echo","value":"a"}"#)
    b.send(#"{"id":"1","op":"echo","value":"b"}"#)
    b.send(#"{"id":"2","op":"nope"}"#)
    XCTAssertEqual(a.readJSON()?["data"], "a")
    let first = b.readJSON()
    let second = b.readJSON()
    let replies = [first, second].compactMap { $0 }
    XCTAssertEqual(replies.count, 2)
    XCTAssertEqual(replies.first { $0["id"] == "1" }?["data"], "b")
    XCTAssertEqual(replies.first { $0["id"] == "2" }?["error"]?["code"], "E_BAD_REQUEST")
  }

  func testSequentialClientsReuseTheSameProcess() throws {
    let tracker = IdleTracker(timeout: 0)
    let server = makeServer(idle: tracker)
    try server.start()
    defer { server.stop() }
    for round in 1...3 {
      let client = try XCTUnwrap(TestClient(path: path))
      XCTAssertEqual(client.readJSON()?["event"], "ready")
      client.send(#"{"id":"1","op":"echo","value":\#(round)}"#)
      XCTAssertEqual(client.readJSON()?["data"], .int(round))
      client.close()
      let deadline = Date().addingTimeInterval(5)
      while tracker.clientCount > 0, Date() < deadline { usleep(5000) }
      XCTAssertEqual(tracker.clientCount, 0)
    }
  }

  func testShutdownFromAnyClientEndsTheServerAfterAnswering() async throws {
    let server = makeServer()
    try server.start()
    let a = try XCTUnwrap(TestClient(path: path))
    let b = try XCTUnwrap(TestClient(path: path))
    defer {
      a.close()
      b.close()
    }
    _ = a.readJSON()
    _ = b.readJSON()
    b.send(#"{"id":"9","op":"shutdown"}"#)
    XCTAssertEqual(b.readJSON(), ["id": "9", "ok": true, "data": ["bye": true]])
    let reason = await server.run()
    XCTAssertEqual(reason, .shutdown)
    XCTAssertFalse(FileManager.default.fileExists(atPath: path))
  }

  func testRequestStopEndsRunWithSignalReasonAndUnlinks() async throws {
    let server = makeServer()
    try server.start()
    server.requestStop(.signal)
    let reason = await server.run()
    XCTAssertEqual(reason, .signal)
    XCTAssertFalse(FileManager.default.fileExists(atPath: path))
  }

  func testIdleServerStopsWithIdleReason() async throws {
    let server = makeServer(idle: IdleTracker(timeout: 0.15))
    try server.start()
    let started = ContinuousClock.now
    let reason = await server.run()
    XCTAssertEqual(reason, .idle)
    XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
  }

  func testStaleSocketFileIsReplaced() throws {
    let stale = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = try UnixSocket.address(for: path)
    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(stale, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    XCTAssertEqual(bound, 0)
    close(stale)  // the file stays, nobody listens
    XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    let server = makeServer()
    try server.start()
    defer { server.stop() }
    let client = try XCTUnwrap(TestClient(path: path))
    XCTAssertEqual(client.readJSON()?["event"], "ready")
    client.close()
  }

  func testLiveSocketIsNotStolen() throws {
    let first = makeServer()
    try first.start()
    defer { first.stop() }
    let second = makeServer()
    XCTAssertThrowsError(try second.start()) { error in
      XCTAssertTrue((error as? UnixSocket.Failure)?.message.contains("already listening") ?? false)
    }
    XCTAssertNotNil(UnixSocket.connect(path: path))
  }

  func testOverlongPathIsRejected() {
    XCTAssertThrowsError(try UnixSocket.address(for: "/" + String(repeating: "a", count: 200)))
  }
}

final class IdleTrackerTests: XCTestCase {
  private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 100
    var now: TimeInterval { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
  }

  private func tracker(timeout: TimeInterval, clock: Clock) -> IdleTracker {
    IdleTracker(timeout: timeout, now: { clock.now })
  }

  func testExpiresAfterTimeoutWithNoClientsAndNoOps() {
    let clock = Clock()
    let idle = tracker(timeout: 2, clock: clock)
    XCTAssertFalse(idle.isExpired())
    clock.advance(1.9)
    XCTAssertFalse(idle.isExpired())
    clock.advance(0.2)
    XCTAssertTrue(idle.isExpired())
  }

  func testAConnectedClientKeepsItAlive() {
    let clock = Clock()
    let idle = tracker(timeout: 2, clock: clock)
    idle.connectionOpened()
    clock.advance(60)
    XCTAssertFalse(idle.isExpired())
    XCTAssertEqual(idle.clientCount, 1)
  }

  func testTimerRestartsWhenTheLastClientLeaves() {
    let clock = Clock()
    let idle = tracker(timeout: 2, clock: clock)
    idle.connectionOpened()
    clock.advance(60)
    idle.connectionClosed()
    XCTAssertFalse(idle.isExpired())
    clock.advance(1.9)
    XCTAssertFalse(idle.isExpired())
    clock.advance(0.2)
    XCTAssertTrue(idle.isExpired())
  }

  func testInFlightOpKeepsItAliveEvenWithoutClients() {
    let clock = Clock()
    let idle = tracker(timeout: 2, clock: clock)
    idle.opStarted(key: "c1:1")
    clock.advance(60)
    XCTAssertFalse(idle.isExpired())
    idle.opFinished(key: "c1:1")
    XCTAssertFalse(idle.isExpired())
    clock.advance(2)
    XCTAssertTrue(idle.isExpired())
  }

  func testSameIdOnTwoConnectionsCountsTwice() {
    let idle = tracker(timeout: 2, clock: Clock())
    idle.opStarted(key: "c1:1")
    idle.opStarted(key: "c2:1")
    XCTAssertEqual(idle.inflightCount, 2)
    idle.opFinished(key: "c1:1")
    XCTAssertEqual(idle.inflightCount, 1)
  }

  func testZeroTimeoutNeverExpires() {
    let clock = Clock()
    let idle = tracker(timeout: 0, clock: clock)
    clock.advance(1_000_000)
    XCTAssertFalse(idle.isExpired())
  }
}

final class OpRequestTests: XCTestCase {
  func testQuietClockCountsOnlyQuietState() {
    XCTAssertNil(QuietClock.quietFor(state: .settling, since: 0, now: 5))
    XCTAssertNil(QuietClock.quietFor(state: nil, since: 0, now: 5))
    XCTAssertEqual(QuietClock.quietFor(state: .quiet, since: 1, now: 1.25) ?? -1, 250, accuracy: 0.001)
    XCTAssertTrue(QuietClock.isSettled(state: .quiet, since: 0, now: 0.25, quietMs: 250))
    XCTAssertFalse(QuietClock.isSettled(state: .quiet, since: 0, now: 0.2, quietMs: 250))
    XCTAssertFalse(QuietClock.isSettled(state: .busy([]), since: 0, now: 9, quietMs: 0))
  }

  func testScreenshotDefaultsAndValidation() throws {
    let plain = try ScreenshotRequest(["id": "1", "op": "screenshot"])
    XCTAssertEqual(plain.scale, 1)
    XCTAssertNil(plain.path)
    let scaled = try ScreenshotRequest(["scale": 0.5, "path": "/tmp/x.png"])
    XCTAssertEqual(scaled.scale, 0.5)
    XCTAssertEqual(scaled.path, "/tmp/x.png")
    for bad: JSON in [["scale": 0], ["scale": 1.5], ["scale": "big"], ["path": ""], ["path": 3]] {
      XCTAssertThrowsError(try ScreenshotRequest(bad)) { XCTAssertEqual(($0 as? WireError)?.code, .badRequest) }
    }
  }

  func testSettleDefaultsAndBudgetPrecedence() throws {
    let defaults = try SettleRequest([:])
    XCTAssertEqual(defaults.quietMs, 250)
    XCTAssertEqual(defaults.timeoutMs, 3000)
    XCTAssertEqual(try SettleRequest(["quietMs": 100, "timeoutMs": 300]).timeoutMs, 300)
    // The TS client overwrites timeoutMs with the envelope value plus a margin; settleTimeoutMs is the real budget.
    XCTAssertEqual(try SettleRequest(["timeoutMs": 3500, "settleTimeoutMs": 3000]).timeoutMs, 3000)
    XCTAssertThrowsError(try SettleRequest(["quietMs": -1]))
    XCTAssertThrowsError(try SettleRequest(["timeoutMs": "soon"]))
  }

  func testOrientationNames() {
    XCTAssertNotNil(Session.settableOrientation("landscapeLeft"))
    XCTAssertNotNil(Session.settableOrientation("portraitUpsideDown"))
    XCTAssertNil(Session.settableOrientation("faceUp"))
    XCTAssertNil(Session.settableOrientation("sideways"))
  }

  func testSelfTimedOpsAreNotRacedByTheEnvelopeTimeout() async {
    let dispatcher = Dispatcher<Int>(handlers: [
      "settle": { _, _ in
        try await Task.sleep(for: .milliseconds(150))
        return ["quiet": false]
      }
    ])
    let request = Request(id: "1", op: "settle", timeoutMs: 20, params: ["id": "1", "op": "settle", "timeoutMs": 20])
    let response = await dispatcher.handle(request, context: 0)
    XCTAssertEqual(response, .success(id: "1", data: ["quiet": false]))
  }
}
