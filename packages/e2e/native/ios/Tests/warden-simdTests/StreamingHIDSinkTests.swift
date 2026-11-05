import FBSimulatorControl
import XCTest

@testable import warden_simd

/// A fake HID operation: consumes events like idb's `send(events:)`, recording each and which operation it was in.
private final class FakeHID: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [(op: Int, event: SimulatorHIDEvent)] = []
  private var operations = 0
  var failOn: SimulatorHIDEvent?

  var events: [(op: Int, event: SimulatorHIDEvent)] { lock.withLock { storage } }
  var opened: Int { lock.withLock { operations } }

  func run(_ events: DeliveredHIDEvents) async throws {
    let op = lock.withLock {
      operations += 1
      return operations
    }
    for await event in events {
      if event == failOn { throw WireError(.hid, "refused") }
      lock.withLock { storage.append((op, event)) }
    }
  }
}

final class StreamingHIDSinkTests: XCTestCase {
  private let down = SimulatorHIDEvent.touch(direction: .down, x: 1, y: 1)
  private let move = SimulatorHIDEvent.touch(direction: .down, x: 2, y: 2)
  private let up = SimulatorHIDEvent.touch(direction: .up, x: 2, y: 2)

  func testEventsOfOneGestureShareOneOperationAndReturnOnceDelivered() async throws {
    let hid = FakeHID()
    let sink = StreamingHIDSink(run: { try await hid.run($0) })
    try await sink.send(down)
    XCTAssertEqual(hid.events.map(\.event), [down])
    try await sink.send(move)
    try await sink.send(up)
    await sink.end()
    XCTAssertEqual(hid.events.map(\.event), [down, move, up])
    XCTAssertEqual(Set(hid.events.map(\.op)), [1])
  }

  func testTheNextGestureOpensANewOperation() async throws {
    let hid = FakeHID()
    let sink = StreamingHIDSink(run: { try await hid.run($0) })
    try await sink.send(down)
    try await sink.send(up)
    await sink.end()
    try await sink.send(down)
    await sink.end()
    for _ in 0..<100 where hid.opened < 2 { try await Task.sleep(for: .milliseconds(2)) }
    XCTAssertEqual(hid.events.map(\.op), [1, 1, 2])
  }

  func testAFailedOperationFailsThePendingSendAndTheNextOpensAnew() async throws {
    let hid = FakeHID()
    hid.failOn = move
    let sink = StreamingHIDSink(run: { try await hid.run($0) })
    try await sink.send(down)
    do {
      try await sink.send(move)
      XCTFail("expected the refusal")
    } catch {
      XCTAssertEqual((error as? WireError)?.code, .hid)
    }
    hid.failOn = nil
    try await sink.send(down)
    XCTAssertEqual(hid.opened, 2)
  }

  func testEndWithNothingOpenIsANoOp() async {
    let sink = StreamingHIDSink(run: { _ in })
    await sink.end()
  }
}
