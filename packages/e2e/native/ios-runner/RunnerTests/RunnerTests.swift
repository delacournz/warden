import Foundation
import XCTest

/// `xcodebuild test-without-building -only-testing:WardenRunnerUITests/RunnerTests/testServe` runs this "test" for as long
/// as the runner should live: it listens on TCP, prints `WARDEN_RUNNER_READY {json}`, serves NDJSON until a `shutdown`
/// request (or the idle timeout), then returns.
///
/// Environment (set in the `.xctestrun`; `xcodebuild` forwards `TEST_RUNNER_<NAME>` as `<NAME>`):
///   WARDEN_RUNNER_PORT          TCP port; 0 or unset picks a free one (the ready line says which)
///   WARDEN_RUNNER_UDID          the device id echoed in the ready event
///   WARDEN_RUNNER_IDLE_SECONDS  exit after this long with no request (default 3600, 0 = never)
final class RunnerTests: XCTestCase {
  func testServe() throws {
    // A failed XCUITest call records an issue; without this it would end the test and kill the listener (PHY-0).
    continueAfterFailure = true

    let environment = ProcessInfo.processInfo.environment
    let port = UInt16(environment["WARDEN_RUNNER_PORT"] ?? "") ?? 0
    let udid = environment["WARDEN_RUNNER_UDID"] ?? "unknown"
    let idleSeconds = Double(environment["WARDEN_RUNNER_IDLE_SECONDS"] ?? "") ?? 3600

    let issues = IssueCollector()
    XCTestObservationCenter.shared.addTestObserver(issues)
    defer { XCTestObservationCenter.shared.removeTestObserver(issues) }

    let executor = XCUIExecutor(issues: issues)
    let screen = executor.screen()
    var bound: UInt16?
    executor.readyFields = { RunnerInfo.readyFields(udid: udid, screen: screen, port: bound) }

    var failure: String?
    let server = RunnerServer(
      port: port, queue: .main, readyFields: { executor.readyFields() },
      handle: { Router.respond(to: $0, executor: executor) })
    try server.start(
      onListening: { listening in
        bound = listening
        print(RunnerInfo.readyLine(executor.readyFields()))
        fflush(stdout)
      },
      onFailure: { error in failure = "\(error)" })

    var lastServed = 0
    var lastActivity = Date()
    while !server.isDone && failure == nil {
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
      if server.served != lastServed {
        lastServed = server.served
        lastActivity = Date()
      }
      if idleSeconds > 0, Date().timeIntervalSince(lastActivity) > idleSeconds { break }
    }
    server.stop()
    if let failure {
      print("WARDEN_RUNNER_FAILED \(failure)")
      XCTFail("listener failed: \(failure)")
    }
  }
}
