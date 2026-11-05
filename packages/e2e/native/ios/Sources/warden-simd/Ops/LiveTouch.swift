import CoreGraphics
import FBSimulatorControl
import Foundation

// Live touch ops (plan WDN-STRM, STRM-6): `touch.down{x,y,pointer?=0,unit?}`, `touch.move{x,y,pointer?,unit?}`,
// `touch.up{x?,y?,pointer?,unit?}`, `touch.cancel` → `{down}` (fingers still down; `cancel` adds `released`).
//
// A viewer's finger streamed as it moves, never a pre-planned path: each op sends at most one HID event at once.
// Coordinates are portrait-up points like the other input ops (`unit:"norm"` is 0...1 of the oriented screen).
//
// The HID has no per-finger contacts, only "one finger at (x,y)" and "two fingers at (a,b)", each down or up, and a
// repeated down is a move. So the state is the set of fingers the client holds and, per finger, whether the HID has it
// pressed. Two fingers down → `twoFingerTouch`; one of two lifting → `twoFingerTouch(.up)` and the other finger stays
// held but unpressed until its next move presses it again (a new contact; the HID cannot lift one of two fingers).
//
// A finger with no down/move for `staleAfter` (10 s) is lifted by the watchdog, so a lost `up` never leaves it stuck.

/// The pure state machine: which fingers are held, where, and what HID events a change needs.
struct LiveTouchState: Sendable {
  static let pointers = 0...1
  static let staleAfter: Double = 10

  struct Finger: Equatable, Sendable {
    var point: CGPoint
    /// The HID holds this finger down. False only for the finger left after one of two lifted.
    var pressed: Bool
    /// When the client last put it down or moved it (seconds, the injected clock).
    var lastAt: Double
  }

  private(set) var fingers: [Int: Finger] = [:]

  var down: Int { fingers.count }

  private static func notDown(_ pointer: Int) -> WireError {
    WireError(
      .badRequest, "pointer \(pointer) is not down (touch.down first)",
      detail: ["reason": "not_down", "pointer": .int(pointer)])
  }

  /// The HID event for the pressed fingers in `direction`, nil when none is pressed.
  private func event(_ direction: SimulatorHIDDirection) -> SimulatorHIDEvent? {
    let pressed = fingers.keys.sorted().compactMap { key in fingers[key].flatMap { $0.pressed ? $0.point : nil } }
    switch pressed.count {
    case 1: return .touch(direction: direction, x: pressed[0].x, y: pressed[0].y)
    case 2: return .twoFingerTouch(direction: direction, finger1: pressed[0], finger2: pressed[1])
    default: return nil
    }
  }

  private mutating func pressAll() {
    for key in fingers.keys { fingers[key]?.pressed = true }
  }

  mutating func touchDown(_ pointer: Int, at point: CGPoint, now: Double) throws -> [SimulatorHIDEvent] {
    guard fingers[pointer] == nil else {
      throw WireError(
        .badRequest, "pointer \(pointer) is already down (touch.up or touch.cancel first)",
        detail: ["reason": "already_down", "pointer": .int(pointer)])
    }
    fingers[pointer] = Finger(point: point, pressed: true, lastAt: now)
    pressAll()
    return event(.down).map { [$0] } ?? []
  }

  mutating func touchMove(_ pointer: Int, to point: CGPoint, now: Double) throws -> [SimulatorHIDEvent] {
    guard fingers[pointer] != nil else { throw Self.notDown(pointer) }
    fingers[pointer]?.point = point
    fingers[pointer]?.lastAt = now
    pressAll()
    return event(.down).map { [$0] } ?? []
  }

  mutating func touchUp(_ pointer: Int, at point: CGPoint?) throws -> [SimulatorHIDEvent] {
    guard let finger = fingers[pointer] else { throw Self.notDown(pointer) }
    if let point { fingers[pointer]?.point = point }
    defer {
      fingers[pointer] = nil
      for key in fingers.keys { fingers[key]?.pressed = false }
    }
    guard finger.pressed else { return [] }
    return event(.up).map { [$0] } ?? []
  }

  /// Lifts every pressed finger and forgets them all; answers how many were held.
  mutating func cancel() -> (events: [SimulatorHIDEvent], released: Int) {
    let released = fingers.count
    let lift = event(.up)
    fingers = [:]
    return (lift.map { [$0] } ?? [], released)
  }

  /// Lifts each finger untouched for `staleAfter` seconds at `now`.
  mutating func expire(now: Double) -> (events: [SimulatorHIDEvent], released: Int) {
    let stale = fingers.filter { now - $0.value.lastAt >= Self.staleAfter }.keys.sorted()
    if stale.count == fingers.count { return cancel() }
    var events: [SimulatorHIDEvent] = []
    for pointer in stale { events += (try? touchUp(pointer, at: nil)) ?? [] }
    return (events, stale.count)
  }
}

/// One simulator's live touch: the state, the HID it sends to, and the stuck-finger watchdog.
actor LiveTouch {
  private let environment: InputEnvironment
  private let now: @Sendable () -> Double
  private let tick: @Sendable () async throws -> Void
  private var state = LiveTouchState()
  private var watchdog: Task<Void, Never>?

  static let names = ["touch.down", "touch.move", "touch.up", "touch.cancel"]

  /// `now` in seconds; `tick` is how long the watchdog sleeps between looks (1 s in the helper).
  init(
    environment: InputEnvironment,
    now: @escaping @Sendable () -> Double = LiveTouch.uptime,
    tick: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(1)) }
  ) {
    self.environment = environment
    self.now = now
    self.tick = tick
  }

  static func uptime() -> Double { ProcessInfo.processInfo.systemUptime }

  func handle(op: String, params json: JSON) async throws -> JSON {
    let params = InputParams(json: json)
    switch op {
    case "touch.down":
      let pointer = try Self.pointer(params)
      let point = try await resolve(params, required: true)!
      return try await apply(try state.touchDown(pointer, at: point, now: now()))
    case "touch.move":
      let pointer = try Self.pointer(params)
      let point = try await resolve(params, required: true)!
      return try await apply(try state.touchMove(pointer, to: point, now: now()))
    case "touch.up":
      let pointer = try Self.pointer(params)
      let point = try await resolve(params, required: false)
      return try await apply(try state.touchUp(pointer, at: point))
    case "touch.cancel":
      let (events, released) = state.cancel()
      try await send(events)
      return ["down": .int(state.down), "released": .int(released)]
    default:
      throw WireError(.badRequest, "unknown touch op \"\(op)\"")
    }
  }

  /// Releases every stale finger now (the watchdog's look); answers how many.
  @discardableResult
  func expire() async -> Int {
    let (events, released) = state.expire(now: now())
    try? await send(events)
    return released
  }

  /// Ends the session's touches (helper shutdown).
  func close() async {
    watchdog?.cancel()
    watchdog = nil
    let (events, _) = state.cancel()
    try? await send(events)
  }

  private func apply(_ events: [SimulatorHIDEvent]) async throws -> JSON {
    try await send(events)
    armWatchdog()
    return ["down": .int(state.down)]
  }

  private func send(_ events: [SimulatorHIDEvent]) async throws {
    guard !events.isEmpty else { return }
    let environment = environment
    try await environment.gate.run {
      for event in events { try await environment.send(event) }
    }
  }

  private func armWatchdog() {
    if state.down == 0 {
      watchdog?.cancel()
      watchdog = nil
      return
    }
    guard watchdog == nil else { return }
    let tick = tick
    watchdog = Task { [weak self] in
      while !Task.isCancelled {
        do { try await tick() } catch { return }
        guard let self else { return }
        if await self.watchdogLook() { return }
      }
    }
  }

  /// One watchdog look; true once nothing is held (the watchdog ends).
  private func watchdogLook() async -> Bool {
    await expire()
    if state.down == 0 {
      watchdog = nil
      return true
    }
    return false
  }

  private static func pointer(_ params: InputParams) throws -> Int {
    guard let raw = params.json["pointer"], raw != .null else { return 0 }
    guard let number = raw.doubleValue, number.rounded() == number, LiveTouchState.pointers.contains(Int(number))
    else {
      throw WireError(.badRequest, "\"pointer\" must be 0 or 1", detail: ["pointer": raw])
    }
    return Int(number)
  }

  /// `{x,y}` in `unit` → portrait-up points; nil when not `required` and absent.
  private func resolve(_ params: InputParams, required: Bool) async throws -> CGPoint? {
    if !required, try params.optional("x") == nil, try params.optional("y") == nil { return nil }
    let unit = try params.unit()
    let x = try params.required("x")
    let y = try params.required("y")
    let size = environment.screen()
    let landscape = unit == .norm ? await environment.isLandscape() : false
    return try ScreenGeometry(width: size.width, height: size.height, landscape: landscape).points(
      x: x, y: y, unit: unit)
  }
}

/// One `LiveTouch` per simulator for the process lifetime, sharing that simulator's HID gate.
final class LiveTouchHolder: @unchecked Sendable {
  private let lock = NSLock()
  private var live: LiveTouch?

  func get(_ make: () -> LiveTouch) -> LiveTouch {
    lock.withLock {
      if let live { return live }
      let created = make()
      live = created
      return created
    }
  }

  func close() async {
    let current = lock.withLock { live }
    await current?.close()
  }
}

enum LiveTouchOps {
  static let names = LiveTouch.names

  static let ops: [String: Dispatcher<Session>.OpHandler] = Dictionary(
    uniqueKeysWithValues: names.map { name in
      let handler: Dispatcher<Session>.OpHandler = { session, params in
        let live = session.liveTouch.get { LiveTouch(environment: InputOps.environment(for: session)) }
        return try await live.handle(op: name, params: params)
      }
      return (name, handler)
    })
}
