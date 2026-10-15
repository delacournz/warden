import FBSimulatorAX
import Foundation

enum HealthOps {
  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "health": { session, params in
      await session.health(probe: params["probe"]?.boolValue ?? false)
    },
    Dispatcher<Session>.shutdownOp: { _, _ in
      ["bye": true]
    },
  ]
}

/// Where Xcode lives and which version it is, without spawning `xcodebuild`.
enum XcodeInfo {
  /// `"26.6 (17F113)"`, or `"unknown"`.
  static func describe() -> String {
    guard let developerDir = developerDirectory() else { return "unknown" }
    let plist = URL(fileURLWithPath: developerDir).deletingLastPathComponent().appendingPathComponent("version.plist")
    guard let info = NSDictionary(contentsOf: plist) else { return "unknown" }
    let version = info["CFBundleShortVersionString"] as? String ?? "?"
    if let build = info["ProductBuildVersion"] as? String { return "\(version) (\(build))" }
    return version
  }

  private static func developerDirectory() -> String? {
    if let env = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !env.isEmpty { return env }
    return try? FileManager.default.destinationOfSymbolicLink(atPath: "/var/db/xcode_select_link")
  }
}

extension Session {
  /// Fields shared by the `ready` event and `health`.
  func identityFields(bridgeStatus: BridgeStatus, lastFailure: BridgeHealth.Failure? = nil) -> [String: JSON] {
    let size = screen
    return [
      "protocol": .int(BuildInfo.protocolVersion),
      "version": .string(BuildInfo.version),
      "udid": .string(udid),
      "hid": ["transport": .string(hidTransport)],
      "ax": axFields(bridgeStatus, lastFailure: lastFailure),
      "screen": ["width": .double(size.width), "height": .double(size.height), "scale": .double(size.scale)],
    ]
  }

  func readyFields() -> [String: JSON] {
    identityFields(bridgeStatus: bridge)
  }

  func axFields(_ status: BridgeStatus, lastFailure: BridgeHealth.Failure? = nil) -> JSON {
    Session.axFields(
      axDefault: axDefault, status: status, lastFailure: lastFailure, now: ProcessInfo.processInfo.systemUptime)
  }

  /// `bridge` is `degraded` (with `lastError`) when the guest is present but the last read through it failed.
  static func axFields(axDefault: String, status: BridgeStatus, lastFailure: BridgeHealth.Failure?, now: Double) -> JSON {
    var fields: [String: JSON] = ["default": .string(axDefault), "bridge": .string(status.name)]
    if case let .failed(reason) = status { fields["error"] = .string(reason) }
    if status == .available, let lastFailure {
      fields["bridge"] = "degraded"
      fields["lastError"] = [
        "message": .string(lastFailure.message), "agoMs": .int(max(0, Int((now - lastFailure.at) * 1000))),
      ]
    }
    return .object(fields)
  }

  /// `probe` additionally reads the frontmost tree through the bridge, which spawns/reuses the in-sim guest and so
  /// proves it works end to end (~100s of ms cold). Without it `bridge` only reflects "resource present + reader built".
  func health(probe: Bool) async -> JSON {
    var status = bridge
    if probe, status == .available, let reader = axBridgeReader {
      do {
        _ = try await withTimeout(
          milliseconds: 15_000, error: { WireError(.timeout, "bridge probe timed out") }
        ) { try await reader.describe(.frontmost, options: AccessibilityRequestOptions()) }
        bridgeHealth.recordSuccess()
      } catch {
        status = .failed(WireError.from(error).message)
      }
    }
    var fields = identityFields(bridgeStatus: status, lastFailure: bridgeHealth.lastFailure)
    fields["idb"] = .string(BuildInfo.idb)
    fields["xcode"] = .string(XcodeInfo.describe())
    fields["coreSimulatorVersion"] = coreSimulatorVersion.map(JSON.string) ?? .null
    fields["state"] = .string(Session.describe(simulator.state))
    fields["uptimeMs"] = .int(uptimeMs)
    if let socket = socket.json { fields["socket"] = socket }
    return .object(fields)
  }
}
