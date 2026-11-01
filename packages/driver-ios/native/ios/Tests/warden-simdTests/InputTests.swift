import CoreGraphics
import FBSimulatorControl
import XCTest

@testable import warden_simd

private final class Recorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [SimulatorHIDEvent] = []
  private var ordered: [KeyboardMap.KeyStep] = []
  private var concurrent = 0
  private(set) var maxConcurrent = 0
  private(set) var shakes = 0

  func record(_ event: SimulatorHIDEvent, holdNs: UInt64 = 0) async {
    lock.withLock {
      storage.append(event)
      ordered.append(.event(event))
      concurrent += 1
      maxConcurrent = max(maxConcurrent, concurrent)
    }
    if holdNs > 0 { try? await Task.sleep(nanoseconds: holdNs) }
    lock.withLock { concurrent -= 1 }
  }

  func pause(_ milliseconds: Int) { lock.withLock { ordered.append(.pause(milliseconds)) } }

  func shake() { lock.withLock { shakes += 1 } }
  /// Key events and pauses in the order they happened.
  var steps: [KeyboardMap.KeyStep] { lock.withLock { ordered } }
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
        gate: gate,
        pause: { recorder.pause($0) }))
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

  // MARK: gesture

  private func path(_ points: [(Double, Double)]) -> JSON {
    .array(points.map { ["x": .double($0.0), "y": .double($0.1)] })
  }

  func testGestureOneFingerSendsTouchDownFramesThenUp() {
    let event = HIDPlan.gesture(
      paths: [[CGPoint(x: 1, y: 2), CGPoint(x: 3, y: 4), CGPoint(x: 5, y: 6)]], frame: 0.016, hold: 0, release: 0)
    XCTAssertEqual(
      event,
      .composite([
        .touch(direction: .down, x: 1, y: 2),
        .delay(0.016), .touch(direction: .down, x: 3, y: 4),
        .delay(0.016), .touch(direction: .down, x: 5, y: 6),
        .touch(direction: .up, x: 5, y: 6),
      ]))
  }

  func testGestureTwoFingersUseTwoFingerTouchAndLiftTogether() {
    let a = [CGPoint(x: 1, y: 1), CGPoint(x: 2, y: 2)]
    let b = [CGPoint(x: 9, y: 9), CGPoint(x: 8, y: 8)]
    let event = HIDPlan.gesture(paths: [a, b], frame: 0.02, hold: 0, release: 0)
    XCTAssertEqual(
      event,
      .composite([
        .twoFingerTouch(direction: .down, finger1: a[0], finger2: b[0]),
        .delay(0.02), .twoFingerTouch(direction: .down, finger1: a[1], finger2: b[1]),
        .twoFingerTouch(direction: .up, finger1: a[1], finger2: b[1]),
      ]))
  }

  func testGestureHoldAndReleaseAddDelays() {
    let p = [CGPoint(x: 1, y: 1), CGPoint(x: 2, y: 2)]
    let event = HIDPlan.gesture(paths: [p], frame: 0.01, hold: 0.5, release: 0.25)
    XCTAssertEqual(
      event,
      .composite([
        .touch(direction: .down, x: 1, y: 1), .delay(0.5),
        .delay(0.01), .touch(direction: .down, x: 2, y: 2),
        .delay(0.25), .touch(direction: .up, x: 2, y: 2),
      ]))
  }

  func testGestureSingleFrameIsATap() {
    let event = HIDPlan.gesture(paths: [[CGPoint(x: 7, y: 8)]], frame: 0.016, hold: 0.1, release: 0)
    XCTAssertEqual(
      event,
      .composite([.touch(direction: .down, x: 7, y: 8), .delay(0.1), .touch(direction: .up, x: 7, y: 8)]))
  }

  func testGestureOpSendsOneCompositeFromTheWire() async throws {
    let recorder = Recorder()
    let result = try await call(
      engine(recorder), "gesture",
      ["paths": [path([(1, 2), (3, 4)])], "frameMs": 20, "holdMs": 100, "releaseMs": 50])
    XCTAssertEqual(result, .object([:]))
    XCTAssertEqual(
      recorder.events,
      [
        .composite([
          .touch(direction: .down, x: 1, y: 2), .delay(0.1),
          .delay(0.02), .touch(direction: .down, x: 3, y: 4),
          .delay(0.05), .touch(direction: .up, x: 3, y: 4),
        ])
      ])
  }

  func testGestureNormResolvesLandscapeOncePerOp() async throws {
    let recorder = Recorder()
    let counter = Recorder()
    let engine = InputEngine(
      environment: InputEnvironment(
        send: { await recorder.record($0) },
        screen: { (390, 844) },
        isLandscape: {
          await counter.record(.delay(0))
          return true
        },
        shake: {}))
    _ = try await call(
      engine, "gesture", ["paths": [path([(0, 0), (1, 1)]), path([(1, 0), (0, 1)])], "unit": "norm"])
    XCTAssertEqual(counter.events.count, 1)
    XCTAssertEqual(
      recorder.events.first,
      .composite([
        .twoFingerTouch(direction: .down, finger1: CGPoint(x: 0, y: 0), finger2: CGPoint(x: 844, y: 0)),
        .delay(0.016),
        .twoFingerTouch(direction: .down, finger1: CGPoint(x: 844, y: 390), finger2: CGPoint(x: 0, y: 390)),
        .twoFingerTouch(direction: .up, finger1: CGPoint(x: 844, y: 390), finger2: CGPoint(x: 0, y: 390)),
      ]))
  }

  func testGestureRejectsBadShapes() async {
    let one = path([(1, 1), (2, 2)])
    let many = path((0..<1001).map { (Double($0), 0) })
    let cases: [[String: JSON]] = [
      ["paths": []],
      ["paths": [one, one, one]],
      ["paths": [one, path([(1, 1)])]],
      ["paths": [many]],
      ["paths": [.array([])]],
      ["paths": [one], "frameMs": 0],
      ["paths": [one], "frameMs": 1001],
      ["paths": [one], "holdMs": -1],
      ["paths": [one], "holdMs": 60001],
      ["paths": [one], "releaseMs": 60001],
      ["paths": [one], "holdMs": 30000, "releaseMs": 30000, "frameMs": 1],
      ["paths": [[1, 2]]],
      ["paths": [[["x": 1]]]],
      ["paths": "nope"],
      ["paths": [one], "unit": "px"],
      ["paths": [path([(2, 0), (1, 1)])], "unit": "norm"],
    ]
    for params in cases {
      let error = await failure { try await call(engine(Recorder()), "gesture", params) }
      XCTAssertEqual(error?.code, .badRequest, "\(params)")
    }
  }

  func testGestureRejectsNaNFrameMs() async {
    let error = await failure {
      try await call(engine(Recorder()), "gesture", ["paths": [path([(1, 1), (2, 2)])], "frameMs": .double(.nan)])
    }
    XCTAssertEqual(error?.code, .badRequest)
  }

  func testGestureTotalDurationOverSixtySecondsIsRejectedButExactlySixtyPasses() async throws {
    let over = await failure {
      try await call(
        engine(Recorder()), "gesture",
        ["paths": [path((0..<61).map { (Double($0), 0) })], "frameMs": 1000, "holdMs": 1])
    }
    XCTAssertEqual(over?.code, .badRequest)
    _ = try await call(
      engine(Recorder()), "gesture", ["paths": [path((0..<61).map { (Double($0), 0) })], "frameMs": 1000])
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
    XCTAssertEqual(
      recorder.steps,
      KeyboardMap.chordSteps(
        usage: 0x04, modifiers: [0xE3, 0xE1], paceMs: KeyboardMap.defaultPaceMs, holdMs: KeyboardMap.defaultHoldMs))
  }

  func testKeyByName() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "key", ["name": "Enter"])
    XCTAssertEqual(
      recorder.steps,
      KeyboardMap.chordSteps(
        usage: 0x28, modifiers: [], paceMs: KeyboardMap.defaultPaceMs, holdMs: KeyboardMap.defaultHoldMs))
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

  /// Cmd+A is held and followed by a pause like every key, so the selection exists before the Backspace that follows.
  func testSelectAllSendsPacedCmdA() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "selectAll", [:])
    XCTAssertEqual(recorder.steps, KeyboardMap.selectAll(paceMs: KeyboardMap.defaultPaceMs, holdMs: KeyboardMap.defaultHoldMs))
  }

  func testSelectAllTakesPacingOverrides() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "selectAll", ["paceMs": 0, "holdMs": 0])
    XCTAssertEqual(recorder.steps, KeyboardMap.selectAll())
  }

  // MARK: typeText

  func testTypeTextStreamsEveryKeyEventInOrderAndReportsCount() async throws {
    let recorder = Recorder()
    let result = try await call(
      engine(recorder), "typeText", ["text": "Hello, World 123!", "paceMs": 0, "holdMs": 0, "repeatGapMs": 0, "leadMs": 0])
    XCTAssertEqual(result, ["typed": 17])
    XCTAssertEqual(recorder.steps, KeyboardMap.plan(typing: "Hello, World 123!").steps)
    XCTAssertFalse(recorder.events.contains { $0.subEvents != nil }, "events are streamed, not one composite")
  }

  /// The pauses are slept by the helper between the streamed events, in order, not baked into idb `.delay`s.
  func testTypeTextSleepsBetweenEventsNotInsideThem() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "typeText", ["text": "ab", "paceMs": 7, "holdMs": 9, "repeatGapMs": 0, "leadMs": 0])
    XCTAssertEqual(
      recorder.steps,
      [
        .event(.keyboard(direction: .down, keyCode: 0x04)), .pause(9),
        .event(.keyboard(direction: .up, keyCode: 0x04)), .pause(7),
        .event(.keyboard(direction: .down, keyCode: 0x05)), .pause(9),
        .event(.keyboard(direction: .up, keyCode: 0x05)), .pause(7),
      ])
  }

  func testTypeTextSendsThroughTheStreamSeamWhenThereIsOne() async throws {
    let recorder = Recorder()
    let engine = InputEngine(
      environment: InputEnvironment(
        send: { _ in XCTFail("a typed string goes through sendStream") },
        screen: { (390, 844) },
        isLandscape: { false },
        shake: {},
        sendStream: { stream in for try await event in stream { await recorder.record(event) } },
        pause: { recorder.pause($0) }))
    _ = try await call(engine, "typeText", ["text": "a", "paceMs": 3, "holdMs": 4, "repeatGapMs": 0])
    XCTAssertEqual(
      recorder.steps,
      [
        .event(.keyboard(direction: .down, keyCode: 0x04)), .pause(4),
        .event(.keyboard(direction: .up, keyCode: 0x04)), .pause(3),
      ])
  }

  /// An op that times out is cancelled mid-pause: the sleep must end and the op fail, not run out the pause.
  func testACancelledOpEndsItsPause() async {
    let recorder = Recorder()
    let engine = InputEngine(
      environment: InputEnvironment(
        send: { await recorder.record($0) },
        screen: { (390, 844) },
        isLandscape: { false },
        shake: {},
        pause: { _ in try await Task.sleep(nanoseconds: 30_000_000_000) }))
    let task = Task { try await engine.handle(op: "typeText", params: ["text": "abc", "paceMs": 30, "holdMs": 40]) }
    try? await Task.sleep(nanoseconds: 100_000_000)
    task.cancel()
    let start = ContinuousClock.now
    do {
      _ = try await task.value
      XCTFail("expected a throw")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertLessThan(ContinuousClock.now - start, .seconds(5))
    XCTAssertEqual(recorder.events, [.keyboard(direction: .down, keyCode: 0x04)], "only the key before the pause")
  }

  /// A React Native field drops keys sent back to back ("ada@example", "Helo"), so by default every key is held
  /// and followed by a pause, and a repeated key is preceded by a longer one. Expressed through the defaults so a
  /// retune only changes `Keyboard.swift`.
  func testTypeTextHoldsAndPacesEveryKeyByDefault() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "typeText", ["text": "ada@example.com"])
    let pauses = recorder.steps.compactMap { step -> Int? in
      if case .pause(let milliseconds) = step { return milliseconds }
      return nil
    }
    XCTAssertEqual(pauses.filter { $0 == KeyboardMap.defaultPaceMs }.count, 15, "a pace per key")
    XCTAssertEqual(pauses.filter { $0 == KeyboardMap.defaultHoldMs }.count, 15, "a hold per key")
    XCTAssertFalse(pauses.contains(KeyboardMap.defaultRepeatGapMs))
  }

  func testTypeTextWaitsBeforeAnIdenticalConsecutiveKeyByDefault() async throws {
    let recorder = Recorder()
    _ = try await call(engine(recorder), "typeText", ["text": "Hello"])
    let gaps = recorder.steps.filter { $0 == .pause(KeyboardMap.defaultRepeatGapMs) }
    XCTAssertEqual(gaps.count, 1, "only the second l")
  }

  func testTypeTextLeadsInAfterTheFirstKeyByDefaultAndTakesAnOverride() async throws {
    let lead = Recorder()
    let custom = Recorder()
    _ = try await call(engine(lead), "typeText", ["text": "Hi"])
    _ = try await call(engine(custom), "typeText", ["text": "Hi", "leadMs": 90])
    XCTAssertEqual(lead.steps.filter { $0 == .pause(KeyboardMap.defaultLeadMs) }.count, 1)
    XCTAssertEqual(custom.steps.filter { $0 == .pause(90) }.count, 1)
  }

  func testTypeTextPaceHoldAndRepeatGapAreConfigurableAndZeroMeansBackToBack() async throws {
    let unpaced = Recorder()
    let paced = Recorder()
    _ = try await call(engine(unpaced), "typeText", ["text": "aab", "paceMs": 0, "holdMs": 0, "repeatGapMs": 0, "leadMs": 0])
    _ = try await call(engine(paced), "typeText", ["text": "aab", "paceMs": 50, "holdMs": 20, "repeatGapMs": 70])
    XCTAssertFalse(unpaced.steps.contains { if case .pause = $0 { true } else { false } })
    XCTAssertEqual(paced.steps.filter { $0 == .pause(50) }.count, 3)
    XCTAssertEqual(paced.steps.filter { $0 == .pause(20) }.count, 3)
    XCTAssertEqual(paced.steps.filter { $0 == .pause(70) }.count, 1)
  }

  func testKeyIsHeldAndFollowedByAPauseUnlessZero() async throws {
    let held = Recorder()
    let bare = Recorder()
    _ = try await call(engine(held), "key", ["name": "Backspace"])
    _ = try await call(engine(bare), "key", ["name": "Backspace", "paceMs": 0, "holdMs": 0])
    XCTAssertEqual(held.steps.last, .pause(KeyboardMap.defaultPaceMs))
    XCTAssertTrue(held.steps.contains(.pause(KeyboardMap.defaultHoldMs)))
    XCTAssertEqual(bare.steps, KeyboardMap.chordSteps(usage: 0x2A, modifiers: []))
  }

  func testPacingParamsMustBeWholeNumbersWithinRange() async {
    for key in ["paceMs", "holdMs", "repeatGapMs"] {
      for value in [JSON.int(-1), .int(1001), .double(2.5), .string("x")] {
        let error = await failure { try await call(engine(Recorder()), "typeText", ["text": "a", key: value]) }
        XCTAssertEqual(error?.code, .badRequest, "\(key)=\(value)")
      }
    }
    let error = await failure { try await call(engine(Recorder()), "key", ["name": "Enter", "holdMs": 5000]) }
    XCTAssertEqual(error?.code, .badRequest)
  }

  func testTypeTextStopsAtUnmappableCharacterWithRest() async {
    let recorder = Recorder()
    let error = await failure { try await call(engine(recorder), "typeText", ["text": "ab\u{E9}cd"]) }
    XCTAssertEqual(error?.code, .unsupportedText)
    XCTAssertEqual(error?.detail?["rest"], .string("\u{E9}cd"))
    XCTAssertEqual(recorder.events.count, 4, "the mappable prefix is still typed: a down and an up each for a and b")
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
    // the first holder waits for the test, not a timer: a 150 ms sleep lost to a 20 ms one on a loaded CI runner
    // and the "cancelled" waiter had already run
    let hold = HoldLatch()
    let first = Task {
      try await gate.run {
        started.fulfill()
        await hold.wait()
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
    hold.open()
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

/// Blocks `wait()` callers until `open()`; opened once, it never blocks again.
private final class HoldLatch: @unchecked Sendable {
  private let lock = NSLock()
  private var opened = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      let blocked = lock.withLock { () -> Bool in
        if opened { return false }
        waiters.append(c)
        return true
      }
      if !blocked { c.resume() }
    }
  }

  func open() {
    let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      opened = true
      defer { waiters.removeAll() }
      return waiters
    }
    for c in pending { c.resume() }
  }
}
