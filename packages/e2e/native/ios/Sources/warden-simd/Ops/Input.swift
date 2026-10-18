import CoreGraphics
import FBControlCore
import FBSimulatorControl
import Foundation

// HID input ops: tap, longPress, swipe, drag, pinch, gesture, pressButton, key, typeText, paste, selectAll.
//
// Layout: `HIDPlan` builds idb `SimulatorHIDEvent`s from validated numbers (pure, unit-tested); `InputEngine` parses
// request params, resolves units, and sends the events through a `HIDGate` so only one event stream is in flight at a
// time (other ops stay concurrent); `InputOps.ops` wires an engine to a `Session`.

/// `unit` on the HID ops: `pt` is portrait-up points (the AX frame space, default), `norm` is 0...1 of the screen.
enum CoordinateUnit: String, Sendable {
  case pt
  case norm
}

struct ScreenGeometry: Equatable, Sendable {
  /// Portrait-up size in points.
  let width: Double
  let height: Double
  /// Landscape swaps the axes the normalized fractions are applied to.
  let landscape: Bool

  var oriented: (width: Double, height: Double) {
    landscape ? (height, width) : (width, height)
  }

  /// A point in `unit` -> points. `norm` requires 0...1 and a known screen size.
  func points(x: Double, y: Double, unit: CoordinateUnit) throws -> CGPoint {
    switch unit {
    case .pt:
      return CGPoint(x: x, y: y)
    case .norm:
      guard (0...1).contains(x), (0...1).contains(y) else {
        throw WireError(.badRequest, "normalized coordinates must be within 0...1, got (\(x), \(y))")
      }
      let size = oriented
      guard size.width > 0, size.height > 0 else {
        throw WireError(.internal, "screen size unknown, cannot convert normalized coordinates")
      }
      return CGPoint(x: x * size.width, y: y * size.height)
    }
  }
}

/// Pure event composition. Durations are seconds here, milliseconds on the wire.
enum HIDPlan {
  static let tapGap: Double = 0.06
  static let momentumFreeHold: Double = 0.15
  /// Roughly a display frame: a swipe sample every ~16 ms.
  static let sampleInterval: Double = 0.016

  static func tap(at point: CGPoint, count: Int, hold: Double) -> SimulatorHIDEvent {
    var events: [SimulatorHIDEvent] = []
    for index in 0..<max(1, count) {
      if index > 0 { events.append(.delay(tapGap)) }
      events.append(.touch(direction: .down, x: point.x, y: point.y))
      if hold > 0 { events.append(.delay(hold)) }
      events.append(.touch(direction: .up, x: point.x, y: point.y))
    }
    return .composite(events)
  }

  static func longPress(at point: CGPoint, duration: Double) -> SimulatorHIDEvent {
    .tapAt(x: point.x, y: point.y, duration: duration)
  }

  static func sampleCount(duration: Double) -> Int {
    min(120, max(2, Int((duration / sampleInterval).rounded())))
  }

  /// `momentum: true`: idb's swipe (constant velocity, duplicate final contact). `momentum: false`: ease-out
  /// samples, the final contact repeated, a 150 ms hold, then lift, so the OS reads ~0 release velocity.
  static func swipe(from: CGPoint, to: CGPoint, duration: Double, momentum: Bool) -> SimulatorHIDEvent {
    let steps = sampleCount(duration: duration)
    if momentum {
      let distance = hypot(to.x - from.x, to.y - from.y)
      return .swipe(
        from.x, yStart: from.y, xEnd: to.x, yEnd: to.y, delta: max(distance / Double(steps), 1), duration: duration)
    }
    let stepDelay = duration / Double(steps + 1)
    var events: [SimulatorHIDEvent] = []
    for index in 0...steps {
      let t = Double(index) / Double(steps)
      let eased = 1 - pow(1 - t, 3)
      events.append(
        .touch(direction: .down, x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased))
      events.append(.delay(stepDelay))
    }
    events.append(.touch(direction: .down, x: to.x, y: to.y))
    events.append(.delay(momentumFreeHold))
    events.append(.touch(direction: .up, x: to.x, y: to.y))
    return .composite(events)
  }

  static func drag(from: CGPoint, to: CGPoint, press: Double, duration: Double, release: Double) -> SimulatorHIDEvent {
    let steps = sampleCount(duration: duration)
    let distance = hypot(to.x - from.x, to.y - from.y)
    return .drag(
      from.x, yStart: from.y, xEnd: to.x, yEnd: to.y, delta: max(distance / Double(steps), 1),
      pressDuration: press, duration: duration, releaseDuration: release)
  }

  /// Two fingers `radius` either side of `center` along `angle` (radians, 0 = horizontal), moving to
  /// `radius * scale`. `scale < 1` pinches in.
  static func pinch(center: CGPoint, scale: Double, radius: Double, angle: Double, duration: Double)
    -> SimulatorHIDEvent
  {
    let endRadius = radius * scale
    let steps = min(60, max(2, Int((abs(endRadius - radius) / 8).rounded())))
    let stepDelay = duration / Double(steps + 2)
    let axis = CGPoint(x: cos(angle), y: sin(angle))
    func fingers(_ r: Double) -> (CGPoint, CGPoint) {
      (
        CGPoint(x: center.x - r * axis.x, y: center.y - r * axis.y),
        CGPoint(x: center.x + r * axis.x, y: center.y + r * axis.y)
      )
    }
    var events: [SimulatorHIDEvent] = []
    let start = fingers(radius)
    events.append(.twoFingerTouch(direction: .down, finger1: start.0, finger2: start.1))
    events.append(.delay(stepDelay))
    for index in 1...steps {
      let r = radius + (endRadius - radius) * Double(index) / Double(steps)
      let pair = fingers(r)
      events.append(.twoFingerTouch(direction: .down, finger1: pair.0, finger2: pair.1))
      events.append(.delay(stepDelay))
    }
    let end = fingers(endRadius)
    events.append(.twoFingerTouch(direction: .down, finger1: end.0, finger2: end.1))
    events.append(.delay(stepDelay))
    events.append(.twoFingerTouch(direction: .up, finger1: end.0, finger2: end.1))
    return .composite(events)
  }

  /// One or two equal-length paths replayed frame by frame: down at frame 0, `hold` after it, `frame` between frames,
  /// `release` after the last, then up at the last positions. One path uses single touches, two use
  /// `twoFingerTouch` (the fingers lift together). One frame is a tap.
  static func gesture(paths: [[CGPoint]], frame: Double, hold: Double, release: Double) -> SimulatorHIDEvent {
    func touch(_ index: Int, _ direction: SimulatorHIDDirection) -> SimulatorHIDEvent {
      if paths.count == 2 {
        return .twoFingerTouch(direction: direction, finger1: paths[0][index], finger2: paths[1][index])
      }
      return .touch(direction: direction, x: paths[0][index].x, y: paths[0][index].y)
    }
    let count = paths[0].count
    var events: [SimulatorHIDEvent] = [touch(0, .down)]
    if hold > 0 { events.append(.delay(hold)) }
    for index in 1..<max(count, 1) {
      events.append(.delay(frame))
      events.append(touch(index, .down))
    }
    if release > 0 { events.append(.delay(release)) }
    events.append(touch(count - 1, .up))
    return .composite(events)
  }
}

/// Lets one HID event stream through at a time, FIFO. Waiters that are cancelled (op timeout) leave the queue.
actor HIDGate {
  private var busy = false
  private var waiters: [(id: UUID, continuation: CheckedContinuation<Void, any Error>)] = []

  func run<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
    try await acquire()
    defer { release() }
    return try await body()
  }

  private func acquire() async throws {
    if !busy {
      busy = true
      return
    }
    let id = UUID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        if Task.isCancelled {
          continuation.resume(throwing: CancellationError())
        } else {
          waiters.append((id, continuation))
        }
      }
    } onCancel: {
      Task { await self.cancel(id) }
    }
  }

  private func cancel(_ id: UUID) {
    guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
    waiters.remove(at: index).continuation.resume(throwing: CancellationError())
  }

  private func release() {
    if waiters.isEmpty {
      busy = false
    } else {
      waiters.removeFirst().continuation.resume()
    }
  }
}

/// A param bag with wire-error validation.
struct InputParams {
  let json: JSON

  func optional(_ key: String) throws -> Double? {
    guard let value = json[key], value != .null else { return nil }
    guard let number = value.doubleValue, number.isFinite else {
      throw WireError(.badRequest, "\"\(key)\" must be a finite number")
    }
    return number
  }

  func required(_ key: String) throws -> Double {
    guard let number = try optional(key) else { throw WireError(.badRequest, "missing \"\(key)\"") }
    return number
  }

  /// A whole-millisecond pacing param within 0...1000, `fallback` when absent.
  private func wholeMs(_ key: String, fallback: Int) throws -> Int {
    let ms = try optional(key) ?? Double(fallback)
    guard ms.rounded() == ms, (0...1000).contains(ms) else {
      throw WireError(.badRequest, "\"\(key)\" must be a whole number within 0...1000, got \(ms)")
    }
    return Int(ms)
  }

  /// `paceMs` for `key` / `typeText`: quiet after each key press, default `KeyboardMap.defaultPaceMs`.
  func paceMs() throws -> Int { try wholeMs("paceMs", fallback: KeyboardMap.defaultPaceMs) }

  /// `holdMs`: pause between a key's down and up, default `KeyboardMap.defaultHoldMs`.
  func holdMs() throws -> Int { try wholeMs("holdMs", fallback: KeyboardMap.defaultHoldMs) }

  /// `repeatGapMs`: extra pause before a key identical to the previous one, default `KeyboardMap.defaultRepeatGapMs`.
  func repeatGapMs() throws -> Int { try wholeMs("repeatGapMs", fallback: KeyboardMap.defaultRepeatGapMs) }

  /// Milliseconds -> seconds, within 0...60 s.
  func seconds(_ key: String, default fallback: Double) throws -> Double {
    let ms = try optional(key) ?? fallback
    guard (0...60_000).contains(ms) else {
      throw WireError(.badRequest, "\"\(key)\" must be within 0...60000 ms, got \(ms)")
    }
    return ms / 1000
  }

  func point(_ key: String) throws -> (x: Double, y: Double) {
    guard let object = json[key]?.objectValue else { throw WireError(.badRequest, "missing \"\(key)\" {x,y}") }
    let inner = InputParams(json: .object(object))
    return (try inner.required("x"), try inner.required("y"))
  }

  func unit() throws -> CoordinateUnit {
    guard let raw = json["unit"], raw != .null else { return .pt }
    guard let name = raw.stringValue, let unit = CoordinateUnit(rawValue: name) else {
      throw WireError(.badRequest, "\"unit\" must be \"pt\" or \"norm\"")
    }
    return unit
  }

  /// `paths`: one or two arrays of `{x,y}` points, equal length, 1...1000 points each.
  func paths() throws -> [[(x: Double, y: Double)]] {
    guard let outer = json["paths"]?.arrayValue else { throw WireError(.badRequest, "missing \"paths\" array") }
    guard (1...2).contains(outer.count) else {
      throw WireError(.badRequest, "\"paths\" must hold 1 or 2 paths, got \(outer.count)")
    }
    var result: [[(x: Double, y: Double)]] = []
    for entry in outer {
      guard let points = entry.arrayValue, (1...1000).contains(points.count) else {
        throw WireError(.badRequest, "each path must be an array of 1...1000 {x,y} points")
      }
      result.append(
        try points.map { point in
          guard let object = point.objectValue else { throw WireError(.badRequest, "each path point must be {x,y}") }
          let inner = InputParams(json: .object(object))
          return (try inner.required("x"), try inner.required("y"))
        })
    }
    guard result.allSatisfy({ $0.count == result[0].count }) else {
      throw WireError(.badRequest, "all \"paths\" must have the same number of points")
    }
    return result
  }

  /// A fractional-millisecond duration within `range`, `fallback` when absent.
  func ms(_ key: String, default fallback: Double, within range: ClosedRange<Double>) throws -> Double {
    let value = try optional(key) ?? fallback
    guard range.contains(value) else {
      throw WireError(.badRequest, "\"\(key)\" must be within \(range.lowerBound)...\(range.upperBound) ms, got \(value)")
    }
    return value
  }

  func string(_ key: String) throws -> String {
    guard let value = json[key]?.stringValue else { throw WireError(.badRequest, "missing \"\(key)\" string") }
    return value
  }
}

/// Everything the HID ops need from the outside world, so they run against a recording sink in tests.
struct InputEnvironment: Sendable {
  var send: @Sendable (SimulatorHIDEvent) async throws -> Void
  var screen: @Sendable () -> (width: Double, height: Double)
  var isLandscape: @Sendable () async -> Bool
  var shake: @Sendable () async throws -> Void
  var gate: HIDGate = HIDGate()
}

struct InputEngine: Sendable {
  let environment: InputEnvironment

  /// The screen in `unit`; landscape is read once here (only `norm` needs it).
  private func geometry(_ unit: CoordinateUnit) async -> ScreenGeometry {
    let size = environment.screen()
    let landscape = unit == .norm ? await environment.isLandscape() : false
    return ScreenGeometry(width: size.width, height: size.height, landscape: landscape)
  }

  private func resolve(_ point: (x: Double, y: Double), unit: CoordinateUnit) async throws -> CGPoint {
    try await geometry(unit).points(x: point.x, y: point.y, unit: unit)
  }

  private func send(_ event: SimulatorHIDEvent) async throws -> JSON {
    let environment = environment
    try await environment.gate.run { try await environment.send(event) }
    return .object([:])
  }

  func handle(op: String, params json: JSON) async throws -> JSON {
    let params = InputParams(json: json)
    switch op {
    case "tap":
      let unit = try params.unit()
      let point = try await resolve((try params.required("x"), try params.required("y")), unit: unit)
      let count = Int(try params.optional("count") ?? 1)
      guard (1...10).contains(count) else { throw WireError(.badRequest, "\"count\" must be within 1...10") }
      return try await send(HIDPlan.tap(at: point, count: count, hold: try params.seconds("durationMs", default: 0)))
    case "longPress":
      let unit = try params.unit()
      let point = try await resolve((try params.required("x"), try params.required("y")), unit: unit)
      return try await send(HIDPlan.longPress(at: point, duration: try params.seconds("durationMs", default: 800)))
    case "swipe":
      let unit = try params.unit()
      let from = try await resolve(try params.point("from"), unit: unit)
      let to = try await resolve(try params.point("to"), unit: unit)
      let momentum = json["momentum"]?.boolValue ?? true
      return try await send(
        HIDPlan.swipe(from: from, to: to, duration: try params.seconds("durationMs", default: 300), momentum: momentum))
    case "drag":
      let unit = try params.unit()
      let from = try await resolve(try params.point("from"), unit: unit)
      let to = try await resolve(try params.point("to"), unit: unit)
      return try await send(
        HIDPlan.drag(
          from: from, to: to, press: try params.seconds("pressMs", default: 500),
          duration: try params.seconds("durationMs", default: 500),
          release: try params.seconds("releaseMs", default: 100)))
    case "pinch":
      return try await send(try await pinch(params))
    case "gesture":
      return try await send(try await gesture(params))
    case "pressButton":
      return try await pressButton(try params.string("button"))
    case "key":
      return try await send(try Self.keyEvent(params, paceMs: try params.paceMs(), holdMs: try params.holdMs()))
    case "typeText":
      return try await typeText(
        try params.string("text"), paceMs: try params.paceMs(), holdMs: try params.holdMs(),
        repeatGapMs: try params.repeatGapMs())
    case "paste":
      return try await send(KeyboardMap.paste)
    case "selectAll":
      return try await send(KeyboardMap.selectAll(paceMs: try params.paceMs(), holdMs: try params.holdMs()))
    default:
      throw WireError(.badRequest, "unknown input op \"\(op)\"")
    }
  }

  private func pinch(_ params: InputParams) async throws -> SimulatorHIDEvent {
    let unit = try params.unit()
    let center = try await resolve(try params.point("center"), unit: unit)
    var radius = try params.optional("radius") ?? 100
    var scale = try params.optional("scale")
    if let start = try params.optional("startDistance"), let end = try params.optional("endDistance") {
      guard start > 0, end > 0 else { throw WireError(.badRequest, "pinch distances must be positive") }
      radius = start / 2
      scale = end / start
    }
    guard let scale, scale > 0 else { throw WireError(.badRequest, "pinch needs \"scale\" > 0 or start/endDistance") }
    guard radius > 0 else { throw WireError(.badRequest, "\"radius\" must be positive") }
    let degrees = try params.optional("angle") ?? 0
    return HIDPlan.pinch(
      center: center, scale: scale, radius: radius, angle: degrees * .pi / 180,
      duration: try params.seconds("durationMs", default: 400))
  }

  /// `gesture`: validates everything before sending; the whole replay must fit in 60 s.
  private func gesture(_ params: InputParams) async throws -> SimulatorHIDEvent {
    let unit = try params.unit()
    let raw = try params.paths()
    let frameCount = raw[0].count
    let frameMs =
      frameCount > 1 ? try params.ms("frameMs", default: 16, within: 0.001...1000) : 16
    let holdMs = try params.ms("holdMs", default: 0, within: 0...60_000)
    let releaseMs = try params.ms("releaseMs", default: 0, within: 0...60_000)
    let totalMs = Double(frameCount - 1) * frameMs + holdMs + releaseMs
    guard totalMs <= 60_000 else {
      throw WireError(.badRequest, "gesture would take \(totalMs) ms, the limit is 60000")
    }
    let geometry = await geometry(unit)
    let paths = try raw.map { path in try path.map { try geometry.points(x: $0.x, y: $0.y, unit: unit) } }
    return HIDPlan.gesture(paths: paths, frame: frameMs / 1000, hold: holdMs / 1000, release: releaseMs / 1000)
  }

  static let buttons: [String: SimulatorHIDButton] = [
    "home": .homeButton, "lock": .lock, "side": .sideButton, "siri": .siri, "volumeUp": .volumeUp,
    "volumeDown": .volumeDown, "applePay": .applePay,
  ]

  private func pressButton(_ name: String) async throws -> JSON {
    if name == "shake" {
      let environment = environment
      try await environment.gate.run { try await environment.shake() }
      return .object([:])
    }
    guard let button = Self.buttons[name] else {
      throw WireError(.badRequest, "unknown button \"\(name)\"", detail: ["button": .string(name)])
    }
    return try await send(.shortButtonPress(button))
  }

  /// `usage` (numeric) or `name` (a `KeyName`), plus `modifiers` (`shift|cmd|alt|ctrl`).
  static func keyEvent(_ params: InputParams, paceMs: Int = 0, holdMs: Int = 0) throws -> SimulatorHIDEvent {
    let usage: UInt32
    if let raw = try params.optional("usage") {
      guard raw.rounded() == raw, raw >= 0, raw <= 255, KeyboardMap.usageRange.contains(UInt32(raw)) else {
        throw WireError(.badRequest, "\"usage\" must be a keyboard-page usage within 4...231, got \(raw)")
      }
      usage = UInt32(raw)
    } else if let name = params.json["name"]?.stringValue {
      guard let known = KeyboardMap.namedKeys[name] else { throw WireError(.badRequest, "unknown key name \"\(name)\"") }
      usage = known
    } else {
      throw WireError(.badRequest, "key needs \"usage\" or \"name\"")
    }
    var modifiers: [UInt32] = []
    for entry in params.json["modifiers"]?.arrayValue ?? [] {
      guard let name = entry.stringValue, let modifier = KeyboardMap.modifierUsages[name] else {
        throw WireError(.badRequest, "unknown modifier \(entry)")
      }
      if !modifiers.contains(modifier) { modifiers.append(modifier) }
    }
    return KeyboardMap.chord(usage: usage, modifiers: modifiers, paceMs: paceMs, holdMs: holdMs)
  }

  private func typeText(_ text: String, paceMs: Int, holdMs: Int, repeatGapMs: Int) async throws -> JSON {
    let plan = KeyboardMap.plan(typing: text, paceMs: paceMs, holdMs: holdMs, repeatGapMs: repeatGapMs)
    if let event = plan.event { _ = try await send(event) }
    if let rest = plan.rest {
      let first = rest.unicodeScalars.first.map { String($0) } ?? ""
      throw WireError(
        .unsupportedText, "cannot type \"\(first)\" with the HID keyboard",
        detail: ["rest": .string(rest), "typed": .int(plan.typedScalars)])
    }
    return ["typed": .int(plan.typedScalars)]
  }
}

/// Discards idb's HID log lines (they would pollute stderr; ops report failures through the protocol).
final class NullLogger: ControlCoreLogger, @unchecked Sendable {
  let name: String? = nil
  let level: ControlCoreLogLevel = .error
  @discardableResult func log(_ message: String) -> any ControlCoreLogger { self }
  func info() -> any ControlCoreLogger { self }
  func debug() -> any ControlCoreLogger { self }
  func error() -> any ControlCoreLogger { self }
  func withName(_ name: String) -> any ControlCoreLogger { self }
  func withDateFormatEnabled(_ enabled: Bool) -> any ControlCoreLogger { self }
}

enum InputOps {
  static let names = [
    "tap", "longPress", "swipe", "drag", "pinch", "gesture", "pressButton", "key", "typeText", "paste", "selectAll",
  ]

  /// One gate per simulator for the process lifetime (a helper serves one UDID; tests may open several).
  private static let gates = GateRegistry()

  static func environment(for session: Session) -> InputEnvironment {
    let logger = NullLogger()
    let hid = session.hid.hid
    let simulator = session.simulator
    return InputEnvironment(
      send: { event in
        try await hid.send(event: event, logger: logger, drain: .perEvent)
      },
      screen: { (session.screen.width, session.screen.height) },
      isLandscape: {
        switch try? await simulator.orientation.current() {
        case .landscapeLeft, .landscapeRight: return true
        default: return false
        }
      },
      shake: { try await simulator.hardware.shake() },
      gate: gates.gate(for: session.udid))
  }

  static let ops: [String: Dispatcher<Session>.OpHandler] = Dictionary(
    uniqueKeysWithValues: names.map { name in
      let handler: Dispatcher<Session>.OpHandler = { session, params in
        try await InputEngine(environment: environment(for: session)).handle(op: name, params: params)
      }
      return (name, handler)
    })
}

private final class GateRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var gates: [String: HIDGate] = [:]

  func gate(for udid: String) -> HIDGate {
    lock.withLock {
      if let existing = gates[udid] { return existing }
      let created = HIDGate()
      gates[udid] = created
      return created
    }
  }
}
