import FBControlCore
import FBSimulatorControl
import Foundation

enum OrientationOps {
  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "orientation": { session, params in
      try await session.orientation(set: params["set"])
    }
  ]
}

/// The last orientation this process wrote. Some runtimes cannot answer `current()` (the CoreDevice orientation
/// service is missing, `deviceMotionState` absent), so the read falls back to it. Lock-guarded, not an actor, so
/// `Session` stays a plain class.
final class OrientationMemory: @unchecked Sendable {
  private let lock = NSLock()
  private var value: SimulatorDeviceOrientation?

  var last: SimulatorDeviceOrientation? { lock.withLock { value } }
  func remember(_ orientation: SimulatorDeviceOrientation) { lock.withLock { value = orientation } }
}

/// Whether the last snapshot drew the interface landscape (`Session.interfaceScreen`): a hit-test answers one element
/// and no root, so it cannot tell by itself. Forgotten when the orientation is set. Lock-guarded like
/// `OrientationMemory`.
final class InterfaceMemory: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Bool?

  var landscape: Bool? { lock.withLock { value } }
  func remember(landscape: Bool) { lock.withLock { value = landscape } }
  func forget() { lock.withLock { value = nil } }
}

extension Session {
  /// Reads the device orientation, or rotates the device first when `set` is given and waits (up to 3 s) for it to
  /// read back. Writes go through the public HID command (`.device` convention, the one `current()` reads), so a
  /// runtime that cannot read orientation can still be rotated. Reads that fail fall back to the last value written
  /// by this process (`source:"written"`), else portrait (`source:"assumed"`); a real read reports `source:"device"`.
  /// After a write the op also waits for the screen to stop moving (`Session.rotate`) and replies `settled`.
  /// Flat/unknown states are readable (`faceUp`, `faceDown`, `unknown`) but not settable.
  func orientation(set requested: JSON?) async throws -> JSON {
    let commands = simulator.orientation
    var settled: Bool?
    if let requested, requested != .null {
      guard let name = requested.stringValue, let target = Session.settableOrientation(name) else {
        throw WireError(
          .badRequest, "\"set\" must be one of portrait, portraitUpsideDown, landscapeLeft, landscapeRight")
      }
      let hid = try Session.hidOrientation(target)
      settled = try await Session.rotate(
        to: target,
        write: {
          try await commands.set(hid, convention: .device)
          self.orientationMemory.remember(target)
          self.interfaceMemory.forget()
        },
        read: { try? await commands.current() },
        settle: { await self.settleAfterRotation() })
      // the settled interface, so a hit-test before the next snapshot measures against the right screen
      let simulator = self.simulator
      let landscape = await InterfaceOrientation.isLandscape(
        framebuffer: {
          try? await simulator.screenshot.take(
            configuration: ScreenshotConfiguration(encoding: .png, scale: .factor(InterfaceOrientation.probeScale))
          ).size
        },
        device: { nil })
      interfaceMemory.remember(landscape: landscape)
    }
    var reply: [String: JSON]
    if let current = try? await commands.current() {
      orientationMemory.remember(current)
      reply = ["orientation": .string(current.rawValue), "source": .string("device")]
    } else if let last = orientationMemory.last {
      reply = ["orientation": .string(last.rawValue), "source": .string("written")]
    } else {
      reply = ["orientation": .string(SimulatorDeviceOrientation.portrait.rawValue), "source": .string("assumed")]
    }
    if let settled { reply["settled"] = .bool(settled) }
    return .object(reply)
  }

  /// How long the screen must hold still after a rotation before the op answers: the rotation animation runs a few
  /// hundred ms after the device already reads the new orientation, and touches sent during it are dropped.
  static let rotationSettle = (quietMs: 300, timeoutMs: 3000)

  /// The least time between the write and the settle. The quiescence stream does not see the rotation animation, so the
  /// read-back (~400 ms) is what holds the op past its start; a device that reads the new orientation back at once
  /// (seen in a spec run: 317 ms, and the next tap dropped) waits this long instead.
  static let rotationMinimumBeforeSettle: Duration = .milliseconds(400)

  /// Writes the orientation, waits (up to `readDeadline`) for the device to read it back and at least
  /// `minimumBeforeSettle` since the write, then for the screen to stop moving. Answers whether it went quiet (`nil`: no quiescence stream to ask). A write that fails throws before any
  /// wait; a runtime that cannot read orientation back goes straight to the settle.
  static func rotate(
    to target: SimulatorDeviceOrientation,
    write: () async throws -> Void,
    read: () async -> SimulatorDeviceOrientation?,
    settle: () async -> Bool?,
    minimumBeforeSettle: Duration = Session.rotationMinimumBeforeSettle,
    readDeadline: Duration = .seconds(3),
    poll: Duration = .milliseconds(100)
  ) async throws -> Bool? {
    try await write()
    let wrote = ContinuousClock.now
    let deadline = wrote + readDeadline
    while ContinuousClock.now < deadline {
      guard let current = await read() else { break }
      if current == target { break }
      try await Task.sleep(for: poll)
    }
    let earliest = wrote + minimumBeforeSettle
    if ContinuousClock.now < earliest { try await Task.sleep(until: earliest, clock: .continuous) }
    return await settle()
  }

  /// The rotation's settle on the quiescence stream; `nil` when there is no stream (no bridge) or it failed.
  private func settleAfterRotation() async -> Bool? {
    guard axDefault == "axbridge", axBridgeReader != nil else { return nil }
    let window = Session.rotationSettle
    guard
      let request = try? SettleRequest(["quietMs": .int(window.quietMs), "timeoutMs": .int(window.timeoutMs)]),
      let reply = try? await settle(request)
    else { return nil }
    return reply["quiet"]?.boolValue
  }

  static func settableOrientation(_ name: String) -> SimulatorDeviceOrientation? {
    switch name {
    case "portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight":
      return SimulatorDeviceOrientation(rawValue: name)
    default:
      return nil
    }
  }

  /// `SimulatorDeviceOrientation.hidOrientation` is internal to FBSimulatorControl, so the four writable cases are
  /// mapped here.
  static func hidOrientation(_ orientation: SimulatorDeviceOrientation) throws -> SimulatorHIDDeviceOrientation {
    switch orientation {
    case .portrait: return .portrait
    case .portraitUpsideDown: return .portraitUpsideDown
    case .landscapeLeft: return .landscapeLeft
    case .landscapeRight: return .landscapeRight
    case .unknown, .faceUp, .faceDown:
      throw WireError(.badRequest, "orientation \(orientation.rawValue) cannot be set")
    @unknown default:
      throw WireError(.badRequest, "orientation \(orientation.rawValue) cannot be set")
    }
  }
}
