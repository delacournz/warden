import XCTest

@testable import warden_simd

final class ArgumentsTests: XCTestCase {
  func testServeWithUdidAndOptions() throws {
    let args = try Arguments.parse(["--udid", "U", "--resources", "/r", "--log=/tmp/l", "--verbose", "--hid", "dtuhid"]).get()
    XCTAssertEqual(args.mode, .serve)
    XCTAssertEqual(args.udid, "U")
    XCTAssertEqual(args.resources, "/r")
    XCTAssertEqual(args.log, "/tmp/l")
    XCTAssertTrue(args.verbose)
    XCTAssertEqual(args.hid, .dtuhid)
  }

  func testVersionNeedsNoUdid() throws {
    XCTAssertEqual(try Arguments.parse(["--version"]).get().mode, .version)
  }

  func testHealthNeedsUdid() throws {
    XCTAssertEqual(try Arguments.parse(["--health", "--udid", "U"]).get().mode, .health)
    XCTAssertNotNil(failure(["--health"]))
  }

  func testRejectsUnknownMissingValuesAndBadChoices() {
    XCTAssertNotNil(failure(["--udid", "U", "--nope"]))
    XCTAssertNotNil(failure(["--udid"]))
    XCTAssertNotNil(failure(["--udid", "--verbose"]))
    XCTAssertNotNil(failure(["--udid", "U", "--hid", "usb"]))
    XCTAssertNotNil(failure(["--udid", "U", "--ax", "magic"]))
  }

  func testSocketModeWithIdleTimeout() throws {
    let args = try Arguments.parse(["--udid", "U", "--socket", "/tmp/s.sock", "--idle-timeout", "2"]).get()
    XCTAssertEqual(args.socket, "/tmp/s.sock")
    XCTAssertEqual(args.idleTimeout, 2)
    XCTAssertEqual(try Arguments.parse(["--udid", "U", "--socket=/s"]).get().idleTimeout, Arguments.defaultIdleTimeout)
    XCTAssertEqual(try Arguments.parse(["--udid", "U", "--socket", "/s", "--idle-timeout", "0"]).get().idleTimeout, 0)
  }

  func testIdleTimeoutNeedsASocketAndANumber() {
    XCTAssertNotNil(failure(["--udid", "U", "--idle-timeout", "5"]))
    XCTAssertNotNil(failure(["--udid", "U", "--socket", "/s", "--idle-timeout", "soon"]))
    XCTAssertNotNil(failure(["--udid", "U", "--socket", "/s", "--idle-timeout", "-1"]))
  }

  func testHealthOneShotAndSocketAreExclusive() {
    XCTAssertNotNil(failure(["--health", "--udid", "U", "--socket", "/s"]))
  }

  func testOverlongSocketPathIsRejected() {
    XCTAssertNotNil(failure(["--udid", "U", "--socket", "/" + String(repeating: "a", count: 120)]))
  }

  private func failure(_ argv: [String]) -> String? {
    if case let .failure(failure) = Arguments.parse(argv) { return failure.message }
    return nil
  }
}
