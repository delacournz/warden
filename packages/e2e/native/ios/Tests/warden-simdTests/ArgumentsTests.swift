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

  func testSocketModeIsNotYetSupported() {
    XCTAssertTrue(failure(["--udid", "U", "--socket", "/s"])?.contains("D6") ?? false)
  }

  private func failure(_ argv: [String]) -> String? {
    if case let .failure(failure) = Arguments.parse(argv) { return failure.message }
    return nil
  }
}
