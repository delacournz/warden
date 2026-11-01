import Foundation

/// Identity of `warden-runner`: the XCUITest-backed twin of `warden-simd` for real iPhones and iPads. It speaks the same
/// NDJSON protocol (`BuildInfo.protocolVersion`), so the TS side reuses `simd-protocol.ts`.
enum RunnerInfo {
  static let version = "0.1.0"
  static let engine = "xcuitest"
  static let backend = "ax"
  static let readyPrefix = "WARDEN_RUNNER_READY"

  /// Screen in portrait-up points, which is the frame space every element and every coordinate on the wire uses.
  struct Screen: Equatable, Sendable {
    var width: Double
    var height: Double
    var scale: Double

    init(width: Double, height: Double, scale: Double) {
      self.width = width
      self.height = height
      self.scale = scale
    }

    var json: JSON {
      ["width": .double(width), "height": .double(height), "scale": .double(scale)]
    }
  }

  /// The fields of the `ready` event and of the `WARDEN_RUNNER_READY` stdout line. `readyEventSchema` (simd-protocol.ts)
  /// needs `protocol`, `version`, `udid`, `hid`, `ax` and `screen`; `backend` and `engine` say who is answering.
  static func readyFields(udid: String, screen: Screen, port: UInt16?) -> [String: JSON] {
    var fields: [String: JSON] = [
      "protocol": .int(BuildInfo.protocolVersion),
      "version": .string(version),
      "udid": .string(udid),
      "hid": ["transport": "xcuitest"],
      "ax": ["default": .string(backend), "bridge": "missing"],
      "screen": screen.json,
      "backend": .string(backend),
      "engine": .string(engine),
    ]
    if let port { fields["port"] = .int(Int(port)) }
    return fields
  }

  /// `WARDEN_RUNNER_READY {json}`: what `xcodebuild`'s output carries once the listener accepts connections.
  static func readyLine(_ fields: [String: JSON]) -> String {
    let data = NDJSON.encodeLine(Event.ready(fields).json)
    let json = String(decoding: data.dropLast(), as: UTF8.self)
    return "\(readyPrefix) \(json)"
  }

  /// `health` data: the ready identity plus uptime. `ax.bridge` is `missing` (there is no AX bridge guest on a device).
  static func health(fields: [String: JSON], uptimeMs: Int, state: String) -> JSON {
    var health = fields
    health["state"] = .string(state)
    health["uptimeMs"] = .int(uptimeMs)
    return .object(health)
  }
}
