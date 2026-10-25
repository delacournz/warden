import FBControlCore
import FBSimulatorControl
import XCTest

@testable import warden_simd

final class AppOpsTests: XCTestCase {
  private func badRequest(_ make: @autoclosure () throws -> some Any, _ note: String, line: UInt = #line) {
    XCTAssertThrowsError(try make(), note, line: line) { error in
      XCTAssertEqual((error as? WireError)?.code, .badRequest, note, line: line)
    }
  }

  // MARK: launch

  func testLaunchDefaultsToARelaunchWithNoArgsAndNoEnv() throws {
    let request = try LaunchRequest(["bundleId": "a.b"])
    XCTAssertEqual(request.bundleId, "a.b")
    XCTAssertEqual(request.arguments, [])
    XCTAssertEqual(request.environment, [:])
    XCTAssertTrue(request.terminateRunning)
    XCTAssertEqual(request.launchMode, .relaunchIfRunning)
    XCTAssertEqual(try LaunchRequest(["bundleId": "a.b", "args": .null, "env": .null, "terminateRunning": .null]), request)
  }

  func testLaunchCarriesArgsEnvAndTheKeepRunningMode() throws {
    let request = try LaunchRequest([
      "bundleId": "a.b", "args": ["--x", "1"], "env": ["A": "1", "B": "two"], "terminateRunning": false,
    ])
    XCTAssertEqual(request.arguments, ["--x", "1"])
    XCTAssertEqual(request.environment, ["A": "1", "B": "two"])
    XCTAssertFalse(request.terminateRunning)
    XCTAssertEqual(request.launchMode, .foregroundIfRunning)
    let configuration = request.configuration
    XCTAssertEqual(configuration.bundleID, "a.b")
    XCTAssertNil(configuration.bundleName)
    XCTAssertEqual(configuration.arguments, ["--x", "1"])
    XCTAssertEqual(configuration.environment, ["A": "1", "B": "two"])
    XCTAssertFalse(configuration.waitForDebugger)
    XCTAssertEqual(configuration.launchMode, .foregroundIfRunning)
  }

  func testLaunchRejectsMalformedParams() {
    badRequest(try LaunchRequest([:]), "bundleId missing")
    badRequest(try LaunchRequest(["bundleId": ""]), "bundleId empty")
    badRequest(try LaunchRequest(["bundleId": 3]), "bundleId not a string")
    badRequest(try LaunchRequest(["bundleId": "a.b", "args": "--x"]), "args not an array")
    badRequest(try LaunchRequest(["bundleId": "a.b", "args": [1]]), "args not strings")
    badRequest(try LaunchRequest(["bundleId": "a.b", "env": "A=1"]), "env not an object")
    badRequest(try LaunchRequest(["bundleId": "a.b", "env": ["A": 1]]), "env values not strings")
    badRequest(try LaunchRequest(["bundleId": "a.b", "terminateRunning": "yes"]), "terminateRunning not a bool")
  }

  // MARK: terminate / openUrl

  func testTerminateNeedsABundleId() throws {
    XCTAssertEqual(try TerminateRequest(["bundleId": "a.b"]).bundleId, "a.b")
    badRequest(try TerminateRequest([:]), "bundleId missing")
    badRequest(try TerminateRequest(["bundleId": ""]), "bundleId empty")
  }

  func testOpenUrlNeedsAUrlWithAScheme() throws {
    XCTAssertEqual(try OpenUrlRequest(["url": "myapp://home?x=1"]).url, URL(string: "myapp://home?x=1"))
    XCTAssertEqual(try OpenUrlRequest(["url": "https://example.com/a"]).url.scheme, "https")
    badRequest(try OpenUrlRequest([:]), "url missing")
    badRequest(try OpenUrlRequest(["url": ""]), "url empty")
    badRequest(try OpenUrlRequest(["url": 7]), "url not a string")
    badRequest(try OpenUrlRequest(["url": "home/settings"]), "url without a scheme")
  }

  // MARK: replies

  func testRepliesMatchTheGoldens() throws {
    try DocumentFixture.assertGolden(LaunchRequest.reply(pid: 4242), named: "launch.reply.golden.json")
    try DocumentFixture.assertGolden(TerminateRequest.reply(terminated: true), named: "terminate.reply.golden.json")
    XCTAssertEqual(TerminateRequest.reply(terminated: false), ["terminated": false])
  }

  func testTheStandardDispatcherServesTheAppOps() {
    let dispatcher = Dispatcher<Session>.standard()
    for name in AppOps.names {
      XCTAssertNotNil(dispatcher.handlers[name], name)
    }
    XCTAssertFalse(Dispatcher<Session>.selfTimedOps.contains("launch"), "launch is bounded by the envelope timeout")
  }

  // MARK: errors

  func testLaunchErrorsKeepTheirMeaning() {
    struct Underlying: Error {}
    let missing = WireError.from(
      SimulatorApplicationLaunchError.launchingUninstalledApplication(bundleID: "a.b", underlying: Underlying()))
    XCTAssertEqual(missing.code, .appUnavailable)
    XCTAssertEqual(missing.detail?["bundleId"], "a.b")
    XCTAssertEqual(WireError.from(SimulatorApplicationLaunchError.noDataDirectory(bundleID: "a.b")).code, .appUnavailable)
    let running = WireError.from(
      SimulatorApplicationLaunchError.applicationAlreadyRunning(bundleID: "a.b", processIdentifier: 42))
    XCTAssertEqual(running.code, .internal)
    XCTAssertEqual(running.detail?["pid"], 42)
    XCTAssertEqual(
      WireError.from(SimulatorApplicationLaunchError.foregroundIfRunningIncompatibleWithWaitForDebugger).code, .badRequest)
  }

  func testLaunchdAndOpenUrlErrors() {
    let gone = SimulatorLaunchCtlError.noMatchingProcesses(pattern: "UIKitApplication:a.b")
    XCTAssertTrue(Session.isNotRunning(gone))
    XCTAssertEqual(WireError.from(gone).code, .appUnavailable)
    let failed = SimulatorLaunchCtlError.commandFailed(arguments: ["list"], exitCode: 1, stderr: "x")
    XCTAssertFalse(Session.isNotRunning(failed))
    XCTAssertEqual(WireError.from(failed).code, .io)
    let unopened = SimulatorLifecycleError.openURLFailed(
      url: URL(string: "nope://x")!, simulatorDescription: "sim", underlying: nil)
    XCTAssertEqual(WireError.from(unopened).code, .io)
    XCTAssertEqual(WireError.from(SimulatorLifecycleError.focusFailed(applicationDescription: "x")).code, .internal)
  }
}
