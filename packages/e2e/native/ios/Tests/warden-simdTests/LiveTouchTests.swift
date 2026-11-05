import CoreGraphics
import FBSimulatorControl
import XCTest

@testable import warden_simd

/// A fake HID sink: records every event the live touch ops send.
private final class Sink: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [SimulatorHIDEvent] = []

  func record(_ event: SimulatorHIDEvent) { lock.withLock { storage.append(event) } }
  var events: [SimulatorHIDEvent] { lock.withLock { storage } }
  func reset() { lock.withLock { storage = [] } }
}

/// A clock the test moves by hand.
private final class FakeClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Double = 0
  var now: Double { lock.withLock { value } }
  func advance(_ seconds: Double) { lock.withLock { value += seconds } }
}

final class LiveTouchTests: XCTestCase {
  private func touch(
    _ sink: Sink, clock: FakeClock = FakeClock(), landscape: Bool = false,
    tick: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(3600)) }
  ) -> LiveTouch {
    LiveTouch(
      environment: InputEnvironment(
        send: { sink.record($0) },
        screen: { (390, 844) },
        isLandscape: { landscape },
        shake: {}),
      now: { clock.now },
      tick: tick)
  }

  private func call(_ live: LiveTouch, _ op: String, _ params: [String: JSON] = [:]) async throws -> JSON {
    try await live.handle(op: op, params: .object(params))
  }

  private func failure(_ block: () async throws -> JSON) async -> WireError? {
    do {
      _ = try await block()
      return nil
    } catch {
      return error as? WireError
    }
  }

  private func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }

  func testOneFingerDownMoveUpIsOneEventEach() async throws {
    let sink = Sink()
    let live = touch(sink)
    let down = try await call(live, "touch.down", ["x": 10, "y": 20])
    XCTAssertEqual(down, ["down": 1])
    _ = try await call(live, "touch.move", ["x": 12, "y": 40])
    _ = try await call(live, "touch.move", ["x": 14, "y": 60])
    let up = try await call(live, "touch.up", ["x": 15, "y": 70])
    XCTAssertEqual(up, ["down": 0])
    XCTAssertEqual(
      sink.events,
      [
        .touch(direction: .down, x: 10, y: 20),
        .touch(direction: .down, x: 12, y: 40),
        .touch(direction: .down, x: 14, y: 60),
        .touch(direction: .up, x: 15, y: 70),
      ])
  }

  func testUpWithoutPointLiftsWhereTheFingerIs() async throws {
    let sink = Sink()
    let live = touch(sink)
    _ = try await call(live, "touch.down", ["x": 10, "y": 20])
    _ = try await call(live, "touch.move", ["x": 30, "y": 40])
    _ = try await call(live, "touch.up")
    XCTAssertEqual(sink.events.last, .touch(direction: .up, x: 30, y: 40))
  }

  func testMoveWithoutDownIsABadRequest() async {
    let sink = Sink()
    let live = touch(sink)
    let error = await failure { try await self.call(live, "touch.move", ["x": 1, "y": 2]) }
    XCTAssertEqual(error?.code, .badRequest)
    XCTAssertEqual(error?.detail?["reason"], "not_down")
    XCTAssertEqual(sink.events, [])
  }

  func testUpWithoutDownIsABadRequest() async {
    let live = touch(Sink())
    let error = await failure { try await self.call(live, "touch.up", ["x": 1, "y": 2]) }
    XCTAssertEqual(error?.code, .badRequest)
  }

  func testDownTwiceOnOnePointerIsABadRequest() async throws {
    let sink = Sink()
    let live = touch(sink)
    _ = try await call(live, "touch.down", ["x": 1, "y": 2])
    let error = await failure { try await self.call(live, "touch.down", ["x": 3, "y": 4]) }
    XCTAssertEqual(error?.code, .badRequest)
    XCTAssertEqual(error?.detail?["reason"], "already_down")
    XCTAssertEqual(sink.events.count, 1)
  }

  func testPointerOutsideZeroOneIsABadRequest() async {
    let live = touch(Sink())
    for bad: JSON in [2, -1, 0.5, "a"] {
      let error = await failure { try await self.call(live, "touch.down", ["x": 1, "y": 2, "pointer": bad]) }
      XCTAssertEqual(error?.code, .badRequest, "pointer \(bad)")
    }
  }

  func testMissingOrNonFiniteCoordinatesAreBadRequests() async {
    let live = touch(Sink())
    let missing = await failure { try await self.call(live, "touch.down", ["x": 1]) }
    XCTAssertEqual(missing?.code, .badRequest)
  }

  func testTwoPointersMakeATwoFingerTouch() async throws {
    let sink = Sink()
    let live = touch(sink)
    _ = try await call(live, "touch.down", ["x": 100, "y": 100])
    let second = try await call(live, "touch.down", ["x": 200, "y": 300, "pointer": 1])
    XCTAssertEqual(second, ["down": 2])
    _ = try await call(live, "touch.move", ["x": 220, "y": 320, "pointer": 1])
    _ = try await call(live, "touch.move", ["x": 90, "y": 80, "pointer": 0])
    XCTAssertEqual(
      sink.events,
      [
        .touch(direction: .down, x: 100, y: 100),
        .twoFingerTouch(direction: .down, finger1: p(100, 100), finger2: p(200, 300)),
        .twoFingerTouch(direction: .down, finger1: p(100, 100), finger2: p(220, 320)),
        .twoFingerTouch(direction: .down, finger1: p(90, 80), finger2: p(220, 320)),
      ])
  }

  func testLiftingBothFingersSendsOneTwoFingerUp() async throws {
    let sink = Sink()
    let live = touch(sink)
    _ = try await call(live, "touch.down", ["x": 100, "y": 100, "pointer": 0])
    _ = try await call(live, "touch.down", ["x": 200, "y": 200, "pointer": 1])
    sink.reset()
    _ = try await call(live, "touch.up", ["x": 210, "y": 210, "pointer": 1])
    let last = try await call(live, "touch.up", ["x": 110, "y": 110, "pointer": 0])
    XCTAssertEqual(last, ["down": 0])
    XCTAssertEqual(sink.events, [.twoFingerTouch(direction: .up, finger1: p(100, 100), finger2: p(210, 210))])
  }

  func testTheFingerLeftAfterATwoFingerLiftPressesAgainOnItsNextMove() async throws {
    let sink = Sink()
    let live = touch(sink)
    _ = try await call(live, "touch.down", ["x": 100, "y": 100])
    _ = try await call(live, "touch.down", ["x": 200, "y": 200, "pointer": 1])
    _ = try await call(live, "touch.up", ["pointer": 1])
    sink.reset()
    _ = try await call(live, "touch.move", ["x": 120, "y": 130])
    _ = try await call(live, "touch.up", ["x": 120, "y": 140])
    XCTAssertEqual(
      sink.events,
      [.touch(direction: .down, x: 120, y: 130), .touch(direction: .up, x: 120, y: 140)])
  }

  func testCancelLiftsEveryFingerAndClears() async throws {
    let sink = Sink()
    let live = touch(sink)
    _ = try await call(live, "touch.down", ["x": 1, "y": 2])
    _ = try await call(live, "touch.down", ["x": 3, "y": 4, "pointer": 1])
    sink.reset()
    let reply = try await call(live, "touch.cancel")
    XCTAssertEqual(reply, ["down": 0, "released": 2])
    XCTAssertEqual(sink.events, [.twoFingerTouch(direction: .up, finger1: p(1, 2), finger2: p(3, 4))])
    let error = await failure { try await self.call(live, "touch.move", ["x": 1, "y": 2]) }
    XCTAssertEqual(error?.code, .badRequest)
  }

  func testCancelWithNothingDownIsANoOp() async throws {
    let sink = Sink()
    let live = touch(sink)
    let reply = try await call(live, "touch.cancel")
    XCTAssertEqual(reply, ["down": 0, "released": 0])
    XCTAssertEqual(sink.events, [])
  }

  func testAFingerStillFor10SecondsIsReleased() async throws {
    let sink = Sink()
    let clock = FakeClock()
    let live = touch(sink, clock: clock)
    _ = try await call(live, "touch.down", ["x": 5, "y": 6])
    clock.advance(9)
    _ = try await call(live, "touch.move", ["x": 7, "y": 8])
    clock.advance(9.9)
    let early = await live.expire()
    XCTAssertEqual(early, 0)
    clock.advance(0.2)
    let released = await live.expire()
    XCTAssertEqual(released, 1)
    XCTAssertEqual(sink.events.last, .touch(direction: .up, x: 7, y: 8))
    let late = await failure { try await self.call(live, "touch.up", ["x": 7, "y": 8]) }
    XCTAssertEqual(late?.code, .badRequest)
  }

  func testOnlyTheStaleFingerOfTwoIsReleased() async throws {
    let sink = Sink()
    let clock = FakeClock()
    let live = touch(sink, clock: clock)
    _ = try await call(live, "touch.down", ["x": 1, "y": 1])
    _ = try await call(live, "touch.down", ["x": 2, "y": 2, "pointer": 1])
    clock.advance(6)
    _ = try await call(live, "touch.move", ["x": 3, "y": 3, "pointer": 1])
    clock.advance(4)
    let released = await live.expire()
    XCTAssertEqual(released, 1)
    XCTAssertEqual(sink.events.last, .twoFingerTouch(direction: .up, finger1: p(1, 1), finger2: p(3, 3)))
    _ = try await call(live, "touch.move", ["x": 4, "y": 4, "pointer": 1])
    XCTAssertEqual(sink.events.last, .touch(direction: .down, x: 4, y: 4))
  }

  func testTheWatchdogReleasesAStuckFingerByItself() async throws {
    let sink = Sink()
    let clock = FakeClock()
    let live = touch(sink, clock: clock, tick: { try await Task.sleep(for: .milliseconds(5)) })
    _ = try await call(live, "touch.down", ["x": 5, "y": 6])
    clock.advance(11)
    for _ in 0..<200 where sink.events.count < 2 {
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(sink.events.last, .touch(direction: .up, x: 5, y: 6))
  }

  func testNormalizedUnitUsesTheRotatedScreen() async throws {
    let sink = Sink()
    let live = touch(sink, landscape: true)
    _ = try await call(live, "touch.down", ["x": 0.5, "y": 0.5, "unit": "norm"])
    XCTAssertEqual(sink.events, [.touch(direction: .down, x: 422, y: 195)])
  }

  func testUnknownOpNamesItself() async {
    let error = await failure { try await self.call(self.touch(Sink()), "touch.wiggle") }
    XCTAssertEqual(error?.code, .badRequest)
  }

  func testOpsAreRegisteredInTheStandardDispatcher() {
    for name in LiveTouchOps.names {
      XCTAssertNotNil(LiveTouchOps.ops[name], name)
    }
    XCTAssertEqual(LiveTouchOps.names, ["touch.down", "touch.move", "touch.up", "touch.cancel"])
  }
}
