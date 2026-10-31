import XCTest

@testable import RunnerCore

final class CommandParserTests: XCTestCase {
  private func parse(_ op: String, _ fields: [String: JSON] = [:]) -> Result<RunnerCommand, WireError> {
    CommandParser.parse(Fixture.request(op, fields))
  }

  private func command(_ op: String, _ fields: [String: JSON] = [:]) throws -> RunnerCommand {
    try parse(op, fields).get()
  }

  private func error(_ op: String, _ fields: [String: JSON] = [:]) -> WireError? {
    if case let .failure(error) = parse(op, fields) { return error }
    return nil
  }

  func testTapDefaultsToPointsOnceWithoutHold() throws {
    XCTAssertEqual(
      try command("tap", ["x": 10, "y": 20]), .tap(at: Target(x: 10, y: 20, unit: .pt), count: 1, holdMs: 0, bundleId: nil))
  }

  func testTapReadsUnitCountHoldAndBundle() throws {
    let parsed = try command(
      "tap", ["x": 0.5, "y": 0.25, "unit": "norm", "count": 2, "durationMs": 50, "bundleId": "com.example"])
    XCTAssertEqual(parsed, .tap(at: Target(x: 0.5, y: 0.25, unit: .norm), count: 2, holdMs: 50, bundleId: "com.example"))
  }

  func testNormTargetsResolveAgainstThePortraitScreen() {
    XCTAssertEqual(Target(x: 0.5, y: 0.25, unit: .norm).resolve(width: 440, height: 956), Point(x: 220, y: 239))
    XCTAssertEqual(Target(x: 5, y: 6, unit: .pt).resolve(width: 440, height: 956), Point(x: 5, y: 6))
  }

  func testTapValidation() {
    XCTAssertEqual(error("tap", ["x": 1])?.code, .badRequest)
    XCTAssertEqual(error("tap", ["x": 1, "y": "2"])?.code, .badRequest)
    XCTAssertEqual(error("tap", ["x": 1, "y": 2, "count": 11])?.code, .badRequest)
    XCTAssertEqual(error("tap", ["x": 1, "y": 2, "unit": "px"])?.code, .badRequest)
    XCTAssertEqual(error("tap", ["x": 1, "y": 2, "durationMs": 70_000])?.code, .badRequest)
    XCTAssertEqual(error("tap", ["x": 1, "y": 2, "bundleId": ""])?.code, .badRequest)
  }

  func testLongPressSwipeAndDragDefaults() throws {
    XCTAssertEqual(
      try command("longPress", ["x": 1, "y": 2]),
      .longPress(at: Target(x: 1, y: 2, unit: .pt), durationMs: 800, bundleId: nil))
    let swipe = try command("swipe", ["from": ["x": 1, "y": 2], "to": ["x": 3, "y": 4]])
    XCTAssertEqual(
      swipe, .swipe(from: Target(x: 1, y: 2, unit: .pt), to: Target(x: 3, y: 4, unit: .pt), durationMs: 300, bundleId: nil))
    let drag = try command("drag", ["from": ["x": 1, "y": 2], "to": ["x": 3, "y": 4], "unit": "norm"])
    XCTAssertEqual(
      drag,
      .drag(
        from: Target(x: 1, y: 2, unit: .norm), to: Target(x: 3, y: 4, unit: .norm), pressMs: 500, durationMs: 500,
        releaseMs: 100, bundleId: nil))
    XCTAssertEqual(error("swipe", ["from": ["x": 1, "y": 2]])?.code, .badRequest)
  }

  func testTypeText() throws {
    XCTAssertEqual(try command("typeText", ["text": "héllo"]), .typeText("héllo", bundleId: nil))
    XCTAssertEqual(try command("typeText", ["text": ""]), .typeText("", bundleId: nil))
    XCTAssertEqual(error("typeText")?.code, .badRequest)
    XCTAssertEqual(error("typeText", ["text": 5])?.code, .badRequest)
  }

  func testKey() throws {
    XCTAssertEqual(
      try command("key", ["name": "Enter"]), .key(KeySpec(key: .named(.enter), modifiers: []), bundleId: nil))
    XCTAssertEqual(
      try command("key", ["usage": 4, "modifiers": ["cmd"]]),
      .key(KeySpec(key: .character("a"), modifiers: [.cmd]), bundleId: nil))
    XCTAssertEqual(error("key")?.code, .badRequest)
    XCTAssertEqual(error("key", ["usage": 0xE1])?.code, .unsupported)
    XCTAssertEqual(error("key", ["name": "Enter", "modifiers": [5]])?.code, .badRequest)
  }

  func testPressButton() throws {
    XCTAssertEqual(try command("pressButton", ["button": "home"]), .pressButton(.home))
    XCTAssertEqual(try command("pressButton", ["button": "volumeUp"]), .pressButton(.volumeUp))
    XCTAssertEqual(try command("pressButton", ["button": "volumeDown"]), .pressButton(.volumeDown))
    for name in ["lock", "side", "siri", "applePay", "shake"] {
      XCTAssertEqual(error("pressButton", ["button": .string(name)])?.code, .unsupported, name)
    }
    XCTAssertEqual(error("pressButton", ["button": "back"])?.code, .badRequest)
    XCTAssertEqual(error("pressButton")?.code, .badRequest)
  }

  func testUnsupportedOpsAreEUnsupportedNotUnknown() {
    for op in ["pinch", "rotate", "gesture", "paste", "selectAll", "settle", "rebind", "elementAtPoint"] {
      let failure = error(op)
      XCTAssertEqual(failure?.code, .unsupported, op)
      XCTAssertEqual(failure?.retryable, false, op)
      XCTAssertEqual(failure?.detail?["op"]?.stringValue, op)
    }
  }

  func testUnknownOpIsBadRequest() {
    XCTAssertEqual(error("fly")?.code, .badRequest)
  }

  func testOrientationReadsButNeverSets() throws {
    XCTAssertEqual(try command("orientation"), .orientation)
    XCTAssertEqual(try command("orientation", ["set": .null]), .orientation)
    XCTAssertEqual(error("orientation", ["set": "landscapeLeft"])?.code, .unsupported)
  }

  func testSnapshotOptions() throws {
    let parsed = try command("snapshot", ["interactiveOnly": true, "maxDepth": 3, "maxNodes": 50, "bundleId": "com.example"])
    guard case let .snapshot(params) = parsed else { return XCTFail("not a snapshot") }
    XCTAssertEqual(params.bundleId, "com.example")
    XCTAssertEqual(params.options, SnapshotEncoder.Options(interactiveOnly: true, maxDepth: 3, maxNodes: 50))
    XCTAssertFalse(params.axbridgeRequested)
    XCTAssertEqual(error("snapshot", ["maxDepth": 0])?.code, .badRequest)
    XCTAssertEqual(error("snapshot", ["maxNodes": 0])?.code, .badRequest)
    XCTAssertEqual(error("snapshot", ["backend": "vision"])?.code, .badRequest)
  }

  func testSnapshotAcceptsAxbridgeAsAFallbackRequest() throws {
    guard case let .snapshot(params) = try command("snapshot", ["backend": "axbridge"]) else { return XCTFail("not a snapshot") }
    XCTAssertTrue(params.axbridgeRequested)
  }

  func testScreenshotScale() throws {
    XCTAssertEqual(try command("screenshot"), .screenshot(scale: 1))
    XCTAssertEqual(try command("screenshot", ["scale": 0.5]), .screenshot(scale: 0.5))
    XCTAssertEqual(error("screenshot", ["scale": 0])?.code, .badRequest)
    XCTAssertEqual(error("screenshot", ["scale": 1.5])?.code, .badRequest)
    XCTAssertEqual(try command("screenshot", ["path": "/tmp/x.png"]), .screenshot(scale: 1))
  }

  func testAppOps() throws {
    XCTAssertEqual(
      try command("launch", ["bundleId": "a.b", "args": ["-x"], "env": ["K": "V"], "terminateRunning": false]),
      .launch(LaunchParams(bundleId: "a.b", arguments: ["-x"], environment: ["K": "V"], terminateRunning: false)))
    XCTAssertEqual(
      try command("launch", ["bundleId": "a.b"]),
      .launch(LaunchParams(bundleId: "a.b", arguments: [], environment: [:], terminateRunning: true)))
    XCTAssertEqual(error("launch")?.code, .badRequest)
    XCTAssertEqual(error("launch", ["bundleId": "a.b", "args": [1]])?.code, .badRequest)
    XCTAssertEqual(error("launch", ["bundleId": "a.b", "env": ["K": 1]])?.code, .badRequest)
    XCTAssertEqual(error("launch", ["bundleId": "a.b", "terminateRunning": "no"])?.code, .badRequest)
    XCTAssertEqual(try command("terminate", ["bundleId": "a.b"]), .terminate(bundleId: "a.b"))
    XCTAssertEqual(error("terminate")?.code, .badRequest)
    XCTAssertEqual(try command("frontmost", ["bundleId": "a.b"]), .frontmost(bundleId: "a.b"))
    XCTAssertEqual(try command("appState", ["bundleId": "a.b"]), .appState(bundleId: "a.b"))
    XCTAssertEqual(try command("openUrl", ["url": "example://x"]), .openUrl(URL(string: "example://x")!))
    XCTAssertEqual(error("openUrl", ["url": "no scheme"])?.code, .badRequest)
    XCTAssertEqual(error("openUrl")?.code, .badRequest)
  }

  func testSimpleOps() throws {
    XCTAssertEqual(try command("health"), .health)
    XCTAssertEqual(try command("alertButtons"), .alertButtons)
    XCTAssertEqual(try command("shutdown"), .shutdown)
  }
}
