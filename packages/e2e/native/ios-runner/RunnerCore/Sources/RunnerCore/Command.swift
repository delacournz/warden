import Foundation

enum CoordinateUnit: String, Equatable, Sendable {
  case pt, norm
}

/// A point as the client sent it. `norm` is a 0-1 fraction of the portrait-up screen.
struct Target: Equatable, Sendable {
  var x: Double
  var y: Double
  var unit: CoordinateUnit

  /// Portrait-up points.
  func resolve(width: Double, height: Double) -> Point {
    unit == .norm ? Point(x: x * width, y: y * height) : Point(x: x, y: y)
  }
}

enum RunnerButton: String, Equatable, Sendable {
  case home, volumeUp, volumeDown
}

struct SnapshotParams: Equatable, Sendable {
  var bundleId: String?
  var options: SnapshotEncoder.Options
  /// The caller asked for `axbridge`, which a device does not have; the answer carries a `fallback` note.
  var axbridgeRequested: Bool
}

struct AuditParams: Equatable, Sendable {
  var bundleId: String
  /// Audit-type names (`AuditEncoder.knownTypes`), never empty.
  var types: [String]
}

struct LaunchParams: Equatable, Sendable {
  var bundleId: String
  var arguments: [String]
  var environment: [String: String]
  var terminateRunning: Bool
}

/// A validated request. Nothing past `CommandParser` re-checks types or ranges.
enum RunnerCommand: Equatable, Sendable {
  case health
  case snapshot(SnapshotParams)
  case tap(at: Target, count: Int, holdMs: Int, bundleId: String?)
  case longPress(at: Target, durationMs: Int, bundleId: String?)
  case swipe(from: Target, to: Target, durationMs: Int, bundleId: String?)
  case drag(from: Target, to: Target, pressMs: Int, durationMs: Int, releaseMs: Int, bundleId: String?)
  case typeText(String, bundleId: String?)
  case key(KeySpec, bundleId: String?)
  case pressButton(RunnerButton)
  case screenshot(scale: Double)
  case orientation
  case alertButtons
  case frontmost(bundleId: String)
  case appState(bundleId: String)
  case audit(AuditParams)
  case launch(LaunchParams)
  case terminate(bundleId: String)
  case openUrl(URL)
  case shutdown
}

/// Request -> `RunnerCommand`. Unsupported ops are `E_UNSUPPORTED` (the TS driver falls back to devicectl or to a
/// slower path), unknown ops `E_BAD_REQUEST`, like the simulator helper's dispatcher.
enum CommandParser {
  /// Ops `warden-simd` serves that XCUITest's API cannot (PHY-3 v1). `settle` is replaced by the driver's
  /// hash-based settle (`nativeSettle: false`).
  static let unsupportedOps: Set<String> = [
    "pinch", "rotate", "gesture", "paste", "selectAll", "settle", "rebind", "elementAtPoint",
  ]

  static let unsupportedButtons: Set<String> = ["lock", "side", "siri", "applePay", "shake"]

  static func parse(_ request: Request) -> Result<RunnerCommand, WireError> {
    do {
      return .success(try command(request))
    } catch let error as WireError {
      return .failure(error)
    } catch {
      return .failure(WireError(.internal, "\(error)"))
    }
  }

  private static func command(_ request: Request) throws -> RunnerCommand {
    let params = Params(json: request.params)
    switch request.op {
    case "health": return .health
    case "shutdown": return .shutdown
    case "snapshot": return .snapshot(try snapshot(params))
    case "tap":
      let count = Int(try params.number("count") ?? 1)
      guard (1...10).contains(count) else { throw WireError(.badRequest, "\"count\" must be within 1...10") }
      return .tap(
        at: try params.target(x: "x", y: "y"), count: count, holdMs: try params.milliseconds("durationMs", fallback: 0),
        bundleId: try params.optionalString("bundleId"))
    case "longPress":
      return .longPress(
        at: try params.target(x: "x", y: "y"), durationMs: try params.milliseconds("durationMs", fallback: 800),
        bundleId: try params.optionalString("bundleId"))
    case "swipe":
      return .swipe(
        from: try params.point("from"), to: try params.point("to"),
        durationMs: try params.milliseconds("durationMs", fallback: 300), bundleId: try params.optionalString("bundleId"))
    case "drag":
      return .drag(
        from: try params.point("from"), to: try params.point("to"),
        pressMs: try params.milliseconds("pressMs", fallback: 500),
        durationMs: try params.milliseconds("durationMs", fallback: 500),
        releaseMs: try params.milliseconds("releaseMs", fallback: 100), bundleId: try params.optionalString("bundleId"))
    case "typeText":
      guard let text = params.json["text"]?.stringValue else { throw WireError(.badRequest, "typeText needs \"text\"") }
      return .typeText(text, bundleId: try params.optionalString("bundleId"))
    case "key":
      let modifiers = try (params.json["modifiers"]?.arrayValue ?? []).map { entry -> String in
        guard let name = entry.stringValue else { throw WireError(.badRequest, "unknown modifier \(entry)") }
        return name
      }
      switch KeyMap.resolve(usage: try params.number("usage"), name: params.json["name"]?.stringValue, modifiers: modifiers) {
      case let .success(spec): return .key(spec, bundleId: try params.optionalString("bundleId"))
      case let .failure(error): throw error
      }
    case "pressButton":
      guard let name = params.json["button"]?.stringValue else { throw WireError(.badRequest, "pressButton needs \"button\"") }
      if unsupportedButtons.contains(name) { throw unsupported("pressButton \"\(name)\"") }
      guard let button = RunnerButton(rawValue: name) else {
        throw WireError(.badRequest, "unknown button \"\(name)\"", detail: ["button": .string(name)])
      }
      return .pressButton(button)
    case "screenshot":
      var scale = 1.0
      if let raw = params.json["scale"], raw != .null {
        guard let value = raw.doubleValue, value > 0, value <= 1 else {
          throw WireError(.badRequest, "\"scale\" must be a number in (0, 1]")
        }
        scale = value
      }
      return .screenshot(scale: scale)
    case "orientation":
      if let set = params.json["set"], set != .null {
        throw WireError(
          .unsupported, "orientation cannot be set from the runner (XCUIDevice.orientation does not rotate the UI); use devicectl",
          detail: ["op": "orientation", "set": set])
      }
      return .orientation
    case "alertButtons": return .alertButtons
    case "frontmost": return .frontmost(bundleId: try params.requiredString("bundleId", op: "frontmost"))
    case "appState": return .appState(bundleId: try params.requiredString("bundleId", op: "appState"))
    case "audit":
      let requested = try params.json["types"].map { raw -> [String] in
        guard raw == .null || raw.arrayValue != nil else { throw WireError(.badRequest, "\"types\" must be an array of strings") }
        return try (raw.arrayValue ?? []).map { item in
          guard let name = item.stringValue else { throw WireError(.badRequest, "\"types\" must be an array of strings") }
          return name
        }
      }
      return .audit(
        AuditParams(
          bundleId: try params.requiredString("bundleId", op: "audit"), types: try AuditEncoder.resolveTypes(requested).get()))
    case "launch": return .launch(try launch(params))
    case "terminate": return .terminate(bundleId: try params.requiredString("bundleId", op: "terminate"))
    case "openUrl":
      guard let raw = params.json["url"]?.stringValue, !raw.isEmpty else {
        throw WireError(.badRequest, "openUrl needs a non-empty \"url\"")
      }
      guard let url = URL(string: raw), url.scheme != nil else {
        throw WireError(.badRequest, "\"url\" must be a URL with a scheme, got \"\(raw)\"")
      }
      return .openUrl(url)
    default:
      if unsupportedOps.contains(request.op) { throw unsupported("op \"\(request.op)\"", op: request.op) }
      throw WireError(.badRequest, "unknown op \"\(request.op)\"")
    }
  }

  private static func unsupported(_ what: String, op: String? = nil) -> WireError {
    WireError(
      .unsupported, "\(what) is not supported by warden-runner (XCUITest)", detail: op.map { ["op": .string($0)] })
  }

  private static func snapshot(_ params: Params) throws -> SnapshotParams {
    var options = SnapshotEncoder.Options()
    options.interactiveOnly = params.json["interactiveOnly"]?.boolValue ?? false
    options.maxDepth = params.json["maxDepth"]?.intValue
    options.maxNodes = params.json["maxNodes"]?.intValue
    if let depth = options.maxDepth, depth < 1 { throw WireError(.badRequest, "maxDepth must be >= 1") }
    if let nodes = options.maxNodes, nodes < 1 { throw WireError(.badRequest, "maxNodes must be >= 1") }
    var axbridge = false
    if let raw = params.json["backend"], raw != .null {
      switch raw.stringValue {
      case "ax": break
      case "axbridge": axbridge = true
      default: throw WireError(.badRequest, "backend must be \"axbridge\" or \"ax\"")
      }
    }
    return SnapshotParams(
      bundleId: try params.optionalString("bundleId"), options: options, axbridgeRequested: axbridge)
  }

  private static func launch(_ params: Params) throws -> LaunchParams {
    let bundleId = try params.requiredString("bundleId", op: "launch")
    var arguments: [String] = []
    if let raw = params.json["args"], raw != .null {
      guard let items = raw.arrayValue else { throw WireError(.badRequest, "\"args\" must be an array of strings") }
      arguments = try items.map { item in
        guard let string = item.stringValue else { throw WireError(.badRequest, "\"args\" must be an array of strings") }
        return string
      }
    }
    var environment: [String: String] = [:]
    if let raw = params.json["env"], raw != .null {
      guard let object = raw.objectValue else { throw WireError(.badRequest, "\"env\" must be an object of strings") }
      environment = try object.mapValues { entry in
        guard let string = entry.stringValue else { throw WireError(.badRequest, "\"env\" must be an object of strings") }
        return string
      }
    }
    var terminateRunning = true
    switch params.json["terminateRunning"] {
    case .none, .some(.null): break
    case let .some(.bool(value)): terminateRunning = value
    default: throw WireError(.badRequest, "\"terminateRunning\" must be a boolean")
    }
    return LaunchParams(
      bundleId: bundleId, arguments: arguments, environment: environment, terminateRunning: terminateRunning)
  }
}

private struct Params {
  let json: JSON

  func number(_ key: String) throws -> Double? {
    guard let raw = json[key], raw != .null else { return nil }
    guard let value = raw.doubleValue, value.isFinite else { throw WireError(.badRequest, "\"\(key)\" must be a number") }
    return value
  }

  func requiredNumber(_ key: String) throws -> Double {
    guard let value = try number(key) else { throw WireError(.badRequest, "missing \"\(key)\"") }
    return value
  }

  func milliseconds(_ key: String, fallback: Int) throws -> Int {
    guard let value = try number(key) else { return fallback }
    guard (0...60_000).contains(value) else {
      throw WireError(.badRequest, "\"\(key)\" must be within 0...60000 ms, got \(value)")
    }
    return Int(value.rounded())
  }

  func unit() throws -> CoordinateUnit {
    guard let raw = json["unit"], raw != .null else { return .pt }
    guard let name = raw.stringValue, let unit = CoordinateUnit(rawValue: name) else {
      throw WireError(.badRequest, "\"unit\" must be \"pt\" or \"norm\"")
    }
    return unit
  }

  func target(x: String, y: String) throws -> Target {
    Target(x: try requiredNumber(x), y: try requiredNumber(y), unit: try unit())
  }

  func point(_ key: String) throws -> Target {
    guard let object = json[key]?.objectValue else { throw WireError(.badRequest, "missing \"\(key)\" {x,y}") }
    let inner = Params(json: .object(object))
    return Target(x: try inner.requiredNumber("x"), y: try inner.requiredNumber("y"), unit: try unit())
  }

  func optionalString(_ key: String) throws -> String? {
    guard let raw = json[key], raw != .null else { return nil }
    guard let string = raw.stringValue, !string.isEmpty else {
      throw WireError(.badRequest, "\"\(key)\" must be a non-empty string")
    }
    return string
  }

  func requiredString(_ key: String, op: String) throws -> String {
    guard let string = json[key]?.stringValue, !string.isEmpty else {
      throw WireError(.badRequest, "\(op) needs a non-empty \"\(key)\"")
    }
    return string
  }
}
