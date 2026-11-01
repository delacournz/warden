import FBControlCore
import FBSimulatorControl
import Foundation

/// `launch`, `terminate`, `openUrl`: app lifecycle done by this process, which already holds CoreSimulator. A
/// client that spawned `xcrun simctl` for each of them paid a CoreSimulator load per call (~0.13 CPU-s on the host).
enum AppOps {
  static let names = ["launch", "terminate", "openUrl"]

  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "launch": { session, params in try await session.launch(LaunchRequest(params)) },
    "terminate": { session, params in try await session.terminate(TerminateRequest(params)) },
    "openUrl": { session, params in try await session.openUrl(OpenUrlRequest(params)) },
  ]
}

private func requiredBundleId(_ params: JSON, op: String) throws -> String {
  guard let id = params["bundleId"]?.stringValue, !id.isEmpty else {
    throw WireError(.badRequest, "\(op) needs a non-empty \"bundleId\"")
  }
  return id
}

/// `launch{bundleId, args?, env?, terminateRunning?}` → `{pid}`.
///
/// `args` follow the executable and `env` reaches the app as given. `terminateRunning` (default true) ends a running
/// instance before starting a new one; false brings a running instance to the front instead, and its pid is answered.
struct LaunchRequest: Equatable, Sendable {
  var bundleId: String
  var arguments: [String]
  var environment: [String: String]
  var terminateRunning: Bool

  init(_ params: JSON) throws {
    bundleId = try requiredBundleId(params, op: "launch")
    arguments = try Self.strings(params["args"], key: "args")
    environment = try Self.environment(params["env"])
    switch params["terminateRunning"] {
    case .none, .some(.null): terminateRunning = true
    case let .some(.bool(value)): terminateRunning = value
    default: throw WireError(.badRequest, "\"terminateRunning\" must be a boolean")
    }
  }

  var launchMode: ApplicationLaunchMode {
    terminateRunning ? .relaunchIfRunning : .foregroundIfRunning
  }

  var configuration: ApplicationLaunchConfiguration {
    ApplicationLaunchConfiguration(
      bundleID: bundleId, bundleName: nil, arguments: arguments, environment: environment, waitForDebugger: false,
      launchMode: launchMode)
  }

  static func reply(pid: pid_t) -> JSON {
    ["pid": .int(Int(pid))]
  }

  private static func strings(_ value: JSON?, key: String) throws -> [String] {
    guard let value, value != .null else { return [] }
    guard let items = value.arrayValue else { throw WireError(.badRequest, "\"\(key)\" must be an array of strings") }
    return try items.map { item in
      guard let string = item.stringValue else { throw WireError(.badRequest, "\"\(key)\" must be an array of strings") }
      return string
    }
  }

  private static func environment(_ value: JSON?) throws -> [String: String] {
    guard let value, value != .null else { return [:] }
    guard let object = value.objectValue else { throw WireError(.badRequest, "\"env\" must be an object of strings") }
    return try object.mapValues { entry in
      guard let string = entry.stringValue else { throw WireError(.badRequest, "\"env\" must be an object of strings") }
      return string
    }
  }
}

/// `terminate{bundleId}` → `{terminated}`; `false` when nothing of that bundle was running, which is not an error.
struct TerminateRequest: Equatable, Sendable {
  var bundleId: String

  init(_ params: JSON) throws {
    bundleId = try requiredBundleId(params, op: "terminate")
  }

  static func reply(terminated: Bool) -> JSON {
    ["terminated": .bool(terminated)]
  }
}

/// `openUrl{url}` → `{}`. The string must parse as a URL with a scheme (what the simulator routes on).
struct OpenUrlRequest: Equatable, Sendable {
  var url: URL

  init(_ params: JSON) throws {
    guard let raw = params["url"]?.stringValue, !raw.isEmpty else {
      throw WireError(.badRequest, "openUrl needs a non-empty \"url\"")
    }
    guard let parsed = URL(string: raw), parsed.scheme != nil else {
      throw WireError(.badRequest, "\"url\" must be a URL with a scheme, got \"\(raw)\"")
    }
    url = parsed
  }
}

extension Session {
  /// Starts the app (ending a running instance first when asked). The pid memory of `frontmost` gets the new pid at
  /// once, so the next probe compares instead of asking launchd.
  func launch(_ request: LaunchRequest) async throws -> JSON {
    bundlePids.remember(nil, for: request.bundleId)
    let launched = try await simulator.application.launch(request.configuration)
    bundlePids.remember(launched.processIdentifier, for: request.bundleId)
    return LaunchRequest.reply(pid: launched.processIdentifier)
  }

  /// Ends the app's process. A bundle with no running process answers `terminated: false`: either launchd said so
  /// outright, or the kill failed and a lookup afterwards finds no process either.
  func terminate(_ request: TerminateRequest) async throws -> JSON {
    defer { bundlePids.remember(nil, for: request.bundleId) }
    do {
      try await simulator.application.kill(bundleID: request.bundleId)
    } catch {
      if Session.isNotRunning(error) { return TerminateRequest.reply(terminated: false) }
      if (try? await simulator.application.processID(forBundleID: request.bundleId)) == nil {
        return TerminateRequest.reply(terminated: false)
      }
      throw error
    }
    return TerminateRequest.reply(terminated: true)
  }

  func openUrl(_ request: OpenUrlRequest) async throws -> JSON {
    try await simulator.lifecycle.open(request.url)
    return .object([:])
  }

  /// launchd has no service for the bundle: nothing is running.
  static func isNotRunning(_ error: any Error) -> Bool {
    if let error = error as? SimulatorLaunchCtlError, case .noMatchingProcesses = error { return true }
    return false
  }
}
