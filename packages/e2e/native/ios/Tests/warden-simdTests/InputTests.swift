import CoreGraphics
import FBSimulatorControl
import XCTest

@testable import warden_simd

private final class Recorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [SimulatorHIDEvent] = []
  private var concurrent = 0
  private(set) var maxConcurrent = 0
  private(set) var shakes = 0

  func record(_ event: SimulatorHIDEvent, holdNs: UInt64 = 0) async {
    lock.withLock {
      storage.append(event)
      concurrent += 1
      maxConcurrent = max(maxConcurrent, concurrent)
    }
    if holdNs > 0 { try? await Task.sleep(nanoseconds: holdNs) }
    lock.withLock { concurrent -= 1 }
  }

  func shake() { lock.withLock { shakes += 1 } }
  var events: [SimulatorHIDEvent] { lock.withLock { storage } }
}

final class InputTests: XCTestCase {
  private func engine(
    _ recorder: Recorder, landscape: Bool = false, holdNs: UInt64 = 0, gate: HIDGate = HIDGate()
  ) -> InputEngine {
    InputEngine(
      environment: InputEnvironment(
        send: { await recorder.record($0, holdNs: holdNs) },
        screen: { (390, 844) },
        isLandscape: { landscape },
        shake: { recorder.shake() },
        gate: gate))
  }

  private func call(_ engine: InputEngine, _ op: String, _ params: [String: JSON]) async throws -> JSON {
    try await engine.handle(op: op, params: .object(params))
  }

  private func failure(_ block: () async throws -> JSON) async -> WireError? {
    do {
      _ = try await block()
      return nil
    } catch {
      return error as? WireError
    }
  }

  // MARK: units

  func testPointUnitsPassThrough() throws {
    let geometry = ScreenGeometry(width: 390, height: 844, landscape: false)
    XCTAssertEqual(try geometry.points(x: 12, y: 34, unit: .pt), CGPoint(x: 12, y: 34))
  }

  func testNormUnitsScaleByTheScreen() throws {
    let geometry = ScreenGeometry(width: 390, height: 844, landscape: false)
    XCTAssertEqual(try geometry.points(x: 0.5, y: 0.25, unit: .norm), CGPoint(x: 195, y: 211))
  }

  func testNormUnitsSwapAxesInLandscape() throws {
    let geometry = ScreenGeometry(width: 390, height: 844, landscape: true)
    XCTAssertEqual(try geometry.points(x: 1, y: 1, unit: .norm), CGPoint(x: 844, y: 390))
  }

  func testNormOutsideZeroToOneIsBadRequest() {
    let geometry = ScreenGeometry(width: 390, height: 844, landscape: false)
    XCTAssertThrowsError(try geometry.points(x: 1.5, y: 0, unit: .norm)) {
      XCTAssertEqual(($0 as? WireError)?.code, .badRequest)
    }
  }

  func testTapHonoursUnitNormEndToEnd() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "tap", ["x": 0.5, "y": 0.5, "unit": "norm"])
    XCTAssertEqual(
      recorder.events,
      [.composite([.touch(direction: .down, x: 195, y: 422), .touch(direction: .up, x: 195, y: 422)])])
  }

  func testUnknownUnitIsBadRequest() async {
    let error = await failure { try await call(engine(Recorder()), "tap", ["x": 1, "y": 1, "unit": "px"]) }
    XCTAssertEqual(error?.code, .badRequest)
  }

  // MARK: tap / longPress

  func testTapWithCountAndHoldComposesDownHoldUpPerTap() {
    let event = HIDPlan.tap(at: CGPoint(x: 1, y: 2), count: 2, hold: 0.05)
    XCTAssertEqual(
      event,
      .composite([
        .touch(direction: .down, x: 1, y: 2), .delay(0.05), .touch(direction: .up, x: 1, y: 2),
        .delay(HIDPlan.tapGap),
        .touch(direction: .down, x: 1, y: 2), .delay(0.05), .touch(direction: .up, x: 1, y: 2),
      ]))
  }

  func testLongPressDefaultsToEightHundredMilliseconds() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "longPress", ["x": 10, "y": 20])
    XCTAssertEqual(recorder.events, [.tapAt(x: 10, y: 20, duration: 0.8)])
  }

  func testTapRejectsMissingCoordinatesAndBadCount() async {
    let missing = await failure { try await call(engine(Recorder()), "tap", ["x": 1]) }
    XCTAssertEqual(missing?.code, .badRequest)
    let count = await failure { try await call(engine(Recorder()), "tap", ["x": 1, "y": 1, "count": 0]) }
    XCTAssertEqual(count?.code, .badRequest)
  }

  // MARK: swipe

  func testMomentumFreeSwipeHoldsBeforeLift() {
    let event = HIDPlan.swipe(from: CGPoint(x: 100, y: 600), to: CGPoint(x: 100, y: 200), duration: 0.3, momentum: false)
    let events = event.subEvents ?? []
    XCTAssertEqual(events.last, .touch(direction: .up, x: 100, y: 200))
    XCTAssertEqual(events[events.count - 2], .delay(0.15), "150 ms hold right before the lift")
    XCTAssertEqual(events[events.count - 3], .touch(direction: .down, x: 100, y: 200))
  }

  func testMomentumFreeSwipeDeceleratesIntoTheEndPoint() {
    let event = HIDPlan.swipe(from: CGPoint(x: 0, y: 1000), to: CGPoint(x: 0, y: 0), duration: 0.3, momentum: false)
    let ys: [Double] = (event.subEvents ?? []).compactMap {
      if case let .touch(_, _, y, _) = $0 { return y }
      return nil
    }
    XCTAssertEqual(ys.first, 1000)
    XCTAssertEqual(ys.last, 0)
    let steps = zip(ys, ys.dropFirst()).map { $0 - $1 }
    XCTAssertTrue(steps.allSatisfy { $0 >= 0 }, "monotonic travel")
    XCTAssertGreaterThan(steps[0], steps[steps.count - 3], "first step larger than the last real step")
  }

  func testMomentumSwipeUsesIdbSwipe() {
    let event = HIDPlan.swipe(from: CGPoint(x: 0, y: 500), to: CGPoint(x: 0, y: 100), duration: 0.3, momentum: true)
    let holds = (event.subEvents ?? []).filter { $0 == .delay(0.15) }
    XCTAssertTrue(holds.isEmpty)
    XCTAssertEqual(event.subEvents?.last, .touch(direction: .up, x: 0, y: 100))
  }

  func testSwipeMomentumFlagComesFromTheRequest() async throws {
    let recorder = Recorder()
    _ = try await call(
      engine(recorder), "swipe",
      ["from": ["x": 1, "y": 2], "to": ["x": 3, "y": 4], "momentum": false])
    let events = recorder.events.first?.subEvents ?? []
    XCTAssertTrue(events.contains(.delay(0.15)))
  }

  // MARK: drag / pinch

  func testDragStartsWithAFiveHundredMillisecondPress() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "drag", ["from": ["x": 10, "y": 10], "to": ["x": 10, "y": 200]])
    let events = recorder.events.first?.subEvents ?? []
    XCTAssertEqual(events[0], .touch(direction: .down, x: 10, y: 10))
    XCTAssertEqual(events[1], .delay(0.5))
    XCTAssertEqual(events.last, .touch(direction: .up, x: 10, y: 200))
  }

  func testPinchInMovesFingersTowardsTheCentre() {
    let event = HIDPlan.pinch(center: CGPoint(x: 200, y: 400), scale: 0.5, radius: 100, angle: 0, duration: 0.4)
    let pairs: [(CGPoint, CGPoint)] = (event.subEvents ?? []).compactMap {
      if case let .twoFingerTouch(_, a, b) = $0 { return (a, b) }
      return nil
    }
    XCTAssertEqual(pairs.first?.0, CGPoint(x: 100, y: 400))
    XCTAssertEqual(pairs.first?.1, CGPoint(x: 300, y: 400))
    XCTAssertEqual(pairs.last?.0.x ?? 0, 150, accuracy: 0.001)
    XCTAssertEqual(pairs.last?.1.x ?? 0, 250, accuracy: 0.001)
    guard case .twoFingerTouch(.up, _, _)? = event.subEvents?.last else { return XCTFail("pinch must end with a lift") }
  }

  func testPinchAngleRotatesTheAxis() {
    let event = HIDPlan.pinch(center: CGPoint(x: 0, y: 0), scale: 2, radius: 10, angle: .pi / 2, duration: 0.2)
    guard case let .twoFingerTouch(_, a, b)? = event.subEvents?.first else { return XCTFail("no touch") }
    XCTAssertEqual(a.x, 0, accuracy: 0.001)
    XCTAssertEqual(a.y, -10, accuracy: 0.001)
    XCTAssertEqual(b.y, 10, accuracy: 0.001)
  }

  func testPinchAcceptsStartAndEndDistance() async throws {
    let recorder = Recorder()
    _ = try await call(
      engine(recorder), "pinch",
      ["center": ["x": 200, "y": 400], "startDistance": 200, "endDistance": 100])
    guard case let .twoFingerTouch(_, a, _)? = recorder.events.first?.subEvents?.first else { return XCTFail("no touch") }
    XCTAssertEqual(a.x, 100, accuracy: 0.001)
  }

  // MARK: buttons

  func testPressButtonMapsNames() async throws {
    let recorder = Recorder()
    let engine = engine(recorder)
    _ = try await call(engine, "pressButton", ["button": "home"])
    _ = try await call(engine, "pressButton", ["button": "volumeUp"])
    _ = try await call(engine, "pressButton", ["button": "side"])
    XCTAssertEqual(
      recorder.events, [.shortButtonPress(.homeButton), .shortButtonPress(.volumeUp), .shortButtonPress(.sideButton)])
  }

  func testShakeUsesTheHardwareCommandNotHID() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "pressButton", ["button": "shake"])
    XCTAssertEqual(recorder.shakes, 1)
    XCTAssertTrue(recorder.events.isEmpty)
  }

  func testUnknownButtonIsBadRequest() async {
    let error = await failure { try await call(engine(Recorder()), "pressButton", ["button": "back"]) }
    XCTAssertEqual(error?.code, .badRequest)
  }

  // MARK: keys

  func testKeyByUsageWithModifiers() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "key", ["usage": 0x04, "modifiers": ["cmd", "shift"]])
    XCTAssertEqual(recorder.events, [KeyboardMap.chord(usage: 0x04, modifiers: [0xE3, 0xE1])])
  }

  func testKeyByName() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "key", ["name": "Enter"])
    XCTAssertEqual(recorder.events, [KeyboardMap.chord(usage: 0x28, modifiers: [])])
  }

  func testKeyRejectsBadUsageNameAndModifier() async {
    for params: [String: JSON] in [
      [:], ["usage": 1], ["usage": 300], ["usage": 4.5], ["name": "Nope"], ["usage": 4, "modifiers": ["hyper"]],
    ] {
      let error = await failure { try await call(engine(Recorder()), "key", params) }
      XCTAssertEqual(error?.code, .badRequest, "\(params)")
    }
  }

  func testPasteSendsCmdV() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "paste", [:])
    XCTAssertEqual(recorder.events, [KeyboardMap.paste])
  }

  // MARK: typeText

  func testTypeTextSendsOneCompositeAndReportsCount() async throws {
    let recorder = Recorder()
    let result = try await call(engine(recorder), "typeText", ["text": "Hello, World 123!"])
    XCTAssertEqual(result, ["typed": 17])
    XCTAssertEqual(recorder.events.count, 1)
  }

  func testTypeTextStopsAtUnmappableCharacterWithRest() async {
    let recorder = Recorder()
    let error = await failure { try await call(engine(recorder), "typeText", ["text": "ab\u{E9}cd"]) }
    XCTAssertEqual(error?.code, .unsupportedText)
    XCTAssertEqual(error?.detail?["rest"], .string("\u{E9}cd"))
    XCTAssertEqual(recorder.events.count, 1, "the mappable prefix is still typed")
  }

  func testTypeTextOfOnlyUnmappableSendsNothing() async {
    let recorder = Recorder()
    let error = await failure { try await call(engine(recorder), "typeText", ["text": "é"]) }
    XCTAssertEqual(error?.code, .unsupportedText)
    XCTAssertEqual(error?.detail?["rest"], .string("é"))
    XCTAssertTrue(recorder.events.isEmpty)
  }

  // MARK: serialisation

  func testHIDOpsNeverOverlap() async throws {
    let recorder = Recorder()
    let engine = engine(recorder, holdNs: 20_000_000)
    try await withThrowingTaskGroup(of: Void.self) { group in
      for index in 0..<8 {
        group.addTask { _ = try await engine.handle(op: "tap", params: .object(["x": .int(index), "y": 0])) }
      }
      try await group.waitForAll()
    }
    XCTAssertEqual(recorder.events.count, 8)
    XCTAssertEqual(recorder.maxConcurrent, 1)
  }

  func testCancelledWaiterLeavesTheQueue() async throws {
    let gate = HIDGate()
    let started = expectation(description: "first holds the gate")
    let first = Task {
      try await gate.run {
        started.fulfill()
        try await Task.sleep(nanoseconds: 150_000_000)
      }
    }
    await fulfillment(of: [started], timeout: 5)
    let waiter = Task { try await gate.run { () -> Int in 1 } }
    try await Task.sleep(nanoseconds: 20_000_000)
    waiter.cancel()
    do {
      _ = try await waiter.value
      XCTFail("a cancelled waiter must not run")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    try await first.value
    let after = try await gate.run { 7 }
    XCTAssertEqual(after, 7)
  }

  func testInputOpsAreRegisteredInTheStandardDispatcher() {
    let handlers = Dispatcher<Session>.standard().handlers
    for name in InputOps.names { XCTAssertNotNil(handlers[name], name) }
    XCTAssertNotNil(handlers["health"])
  }
}
