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

extension Session {
  /// Reads the device orientation, or rotates the device first when `set` is given and waits (up to 3 s) for it to
  /// read back. Writes go through the public HID command (`.device` convention, the one `current()` reads), so a
  /// runtime that cannot read orientation can still be rotated. Reads that fail fall back to the last value written
  /// by this process (`source:"written"`), else portrait (`source:"assumed"`); a real read reports `source:"device"`.
  /// Flat/unknown states are readable (`faceUp`, `faceDown`, `unknown`) but not settable.
  func orientation(set requested: JSON?) async throws -> JSON {
    let commands = simulator.orientation
    if let requested, requested != .null {
      guard let name = requested.stringValue, let target = Session.settableOrientation(name) else {
        throw WireError(
          .badRequest, "\"set\" must be one of portrait, portraitUpsideDown, landscapeLeft, landscapeRight")
      }
      try await commands.set(try Session.hidOrientation(target), convention: .device)
      orientationMemory.remember(target)
      let deadline = ContinuousClock.now + .seconds(3)
      while ContinuousClock.now < deadline {
        guard let read = try? await commands.current() else { break }
        if read == target { break }
        try await Task.sleep(for: .milliseconds(100))
      }
    }
    if let current = try? await commands.current() {
      orientationMemory.remember(current)
      return ["orientation": .string(current.rawValue), "source": .string("device")]
    }
    if let last = orientationMemory.last {
      return ["orientation": .string(last.rawValue), "source": .string("written")]
    }
    return ["orientation": .string(SimulatorDeviceOrientation.portrait.rawValue), "source": .string("assumed")]
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
