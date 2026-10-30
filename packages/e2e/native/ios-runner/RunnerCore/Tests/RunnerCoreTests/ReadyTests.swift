import XCTest

@testable import RunnerCore

final class ReadyTests: XCTestCase {
  private let fields = RunnerInfo.readyFields(udid: "00008140-000A0B0C0D0E0F10", screen: Fixture.screen, port: 8765)

  func testReadyEventMatchesGolden() throws {
    try Fixture.assertGolden(Event.ready(fields).json, named: "ready.event.golden.json")
  }

  func testReadyCarriesTheIdentityTheClientValidates() {
    XCTAssertEqual(fields["protocol"], .int(BuildInfo.protocolVersion))
    XCTAssertEqual(fields["udid"], "00008140-000A0B0C0D0E0F10")
    XCTAssertEqual(fields["hid"], ["transport": "xcuitest"])
    XCTAssertEqual(fields["ax"], ["default": "ax", "bridge": "missing"])
    XCTAssertEqual(fields["backend"], "ax")
    XCTAssertEqual(fields["engine"], "xcuitest")
    XCTAssertEqual(fields["port"], 8765)
    XCTAssertEqual(fields["screen"], ["width": .double(440), "height": .double(956), "scale": .double(3)])
  }

  func testPortIsOmittedWhenUnknown() {
    XCTAssertNil(RunnerInfo.readyFields(udid: "u", screen: Fixture.screen, port: nil)["port"])
  }

  func testReadyLineIsThePrefixAndOneJsonObject() throws {
    let line = RunnerInfo.readyLine(fields)
    XCTAssertTrue(line.hasPrefix("WARDEN_RUNNER_READY {"))
    XCTAssertFalse(line.contains("\n"))
    let json = String(line.dropFirst("WARDEN_RUNNER_READY ".count))
    let parsed = try JSONDecoder().decode(JSON.self, from: Data(json.utf8))
    XCTAssertEqual(parsed["event"], "ready")
    XCTAssertEqual(parsed["engine"], "xcuitest")
  }

  func testHealthGolden() throws {
    try Fixture.assertGolden(RunnerInfo.health(fields: fields, uptimeMs: 0, state: "serving"), named: "health.golden.json")
  }
}
