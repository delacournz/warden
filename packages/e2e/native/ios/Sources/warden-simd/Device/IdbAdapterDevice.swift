import CoreGraphics
import FBControlCore
import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import Foundation

/// Opens one booted simulator through idb's FBSimulatorControl and wraps what the ops use behind the seams in
/// `Seams.swift`. This file, `IdbAdapterAX.swift` and `IdbAdapterErrors.swift` are the only ones that import idb.
enum IdbBackend {
  /// Bootstraps FBSimulatorControl, requires the simulator to be booted, connects HID, builds the AX readers.
  /// Throws `WireError` (`E_UNKNOWN_UDID`, `E_NOT_BOOTED`, `E_HID`, `E_INTERNAL`).
  static func open(udid: String, options: SessionOptions) async throws -> DeviceBackend {
    // The guest binary + shims live next to the executable (or wherever --resources points).
    BundledResources.hostDirectoryPath = options.resources

    let bootstrap: SimulatorControlBootstrap
    do {
      bootstrap = try SimulatorControlBootstrap(
        configuration: SimulatorControlConfiguration(deviceSetPath: nil, logger: nil))
    } catch {
      throw WireError(.internal, "could not load CoreSimulator: \(error.localizedDescription)")
    }
    guard let simulator = bootstrap.set.simulator(withUDID: udid) else {
      throw WireError(.unknownUdid, "no simulator with UDID \(udid) in the default device set")
    }
    guard simulator.state == .booted else {
      throw WireError(
        .notBooted, "simulator \(udid) is \(describe(simulator.state)), not booted",
        detail: ["state": .string(describe(simulator.state))])
    }

    let coreSimulatorVersion = loadedCoreSimulatorVersion()
    let forced: SimulatorHIDTransportType? =
      switch options.hid {
      case .indigo: .indigo
      case .dtuhid: .dtuhid
      case nil: nil
      }
    let session: SimulatorHIDSession
    do {
      session = try await SimulatorHIDSession.open(simulator, transport: forced)
    } catch {
      throw WireError(.hid, "could not connect HID: \(error.localizedDescription)")
    }
    let transport = options.hid?.rawValue ?? negotiatedTransport(coreSimulatorVersion: coreSimulatorVersion)

    var bridge: BridgeStatus = .available
    var bridgeReader: (any AXReader)?
    if BundledResources.path(forItem: "SimulatorFrameworkBridge-iOS") == nil {
      bridge = .missing
    } else {
      do {
        bridgeReader = IdbAXReader(
          reader: try simulator.uiAutomation(
            backend: .axBridge(
              persistence: .exclusive, frontmostMethod: FrontmostPolicy.configured().method.idb, automationMode: true)))
      } catch {
        bridge = .failed(error.localizedDescription)
      }
    }
    let hostReader = (try? simulator.uiAutomation(backend: .accessibility)).map { IdbAXReader(reader: $0) }

    return DeviceBackend(
      device: IdbDevice(simulator: simulator), hid: IdbHID(session: session, simulator: simulator), hidTransport: transport,
      screenshots: IdbScreenshots(simulator: simulator), apps: IdbApps(simulator: simulator),
      orientation: IdbOrientation(simulator: simulator), axBridge: bridgeReader, axHost: hostReader, bridge: bridge,
      coreSimulatorVersion: coreSimulatorVersion)
  }

  /// The transport idb picks when none is forced: DTUHID from CoreSimulator 1155.4 (Xcode 27) on, Indigo before.
  /// idb's own `Simulator.defaultHIDTransport` is not public, so the rule is mirrored here
  /// (`SimulatorHIDTransportSelection` in FBSimulatorControl/HID).
  static func negotiatedTransport(coreSimulatorVersion: String?) -> String {
    guard let version = coreSimulatorVersion, version.compare("1155.4", options: .numeric) != .orderedAscending else {
      return "indigo"
    }
    return "dtuhid"
  }

  static func loadedCoreSimulatorVersion() -> String? {
    guard let simDeviceClass = NSClassFromString("SimDevice") else { return nil }
    return Bundle(for: simDeviceClass).infoDictionary?["CFBundleVersion"] as? String
  }

  static func describe(_ state: TargetState) -> String {
    switch state {
    case .creating: return "creating"
    case .shutdown: return "shutdown"
    case .booting: return "booting"
    case .booted: return "booted"
    case .shuttingDown: return "shutting down"
    default: return "unknown"
    }
  }
}

// MARK: - Device

struct IdbDevice: DeviceInfo, @unchecked Sendable {
  let simulator: Simulator

  var stateName: String { IdbBackend.describe(simulator.state) }

  var screenInfo: ScreenInfo? {
    guard let info = simulator.screenInfo else { return nil }
    return ScreenInfo(widthPixels: Int(info.widthPixels), heightPixels: Int(info.heightPixels), scale: Double(info.scale))
  }
}

// MARK: - HID

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

struct IdbHID: HIDSender, @unchecked Sendable {
  let session: SimulatorHIDSession
  let simulator: Simulator
  private let logger = NullLogger()

  init(session: SimulatorHIDSession, simulator: Simulator) {
    self.session = session
    self.simulator = simulator
  }

  func send(_ event: HIDEvent) async throws {
    let idbEvent = Self.event(event)
    try await IdbErrors.mapping { try await session.hid.send(event: idbEvent, logger: logger, drain: .perEvent) }
  }

  func send(stream: PacedKeyEvents) async throws {
    try await IdbErrors.mapping {
      try await session.hid.send(events: stream.map { Self.event($0) }, logger: logger)
    }
  }

  func shake() async throws {
    try await IdbErrors.mapping { try await simulator.hardware.shake() }
  }

  func close() async {
    await session.close()
  }

  static func direction(_ direction: HIDDirection) -> SimulatorHIDDirection {
    direction == .down ? .down : .up
  }

  static func button(_ button: HIDButton) -> SimulatorHIDButton {
    switch button {
    case .home: return .homeButton
    case .lock: return .lock
    case .side: return .sideButton
    case .siri: return .siri
    case .volumeUp: return .volumeUp
    case .volumeDown: return .volumeDown
    case .applePay: return .applePay
    }
  }

  static func event(_ event: HIDEvent) -> SimulatorHIDEvent {
    switch event {
    case let .touch(direction, x, y):
      return .touch(direction: self.direction(direction), x: x, y: y)
    case let .twoFingerTouch(direction, finger1, finger2):
      return .twoFingerTouch(direction: self.direction(direction), finger1: finger1, finger2: finger2)
    case let .keyboard(direction, keyCode):
      return .keyboard(direction: self.direction(direction), keyCode: keyCode)
    case let .delay(seconds):
      return .delay(seconds)
    case let .composite(events):
      return .composite(events.map(Self.event))
    case let .longPress(x, y, duration):
      return .tapAt(x: x, y: y, duration: duration)
    case let .swipe(xStart, yStart, xEnd, yEnd, delta, duration):
      return .swipe(xStart, yStart: yStart, xEnd: xEnd, yEnd: yEnd, delta: delta, duration: duration)
    case let .drag(xStart, yStart, xEnd, yEnd, delta, pressDuration, duration, releaseDuration):
      return .drag(
        xStart, yStart: yStart, xEnd: xEnd, yEnd: yEnd, delta: delta, pressDuration: pressDuration,
        duration: duration, releaseDuration: releaseDuration)
    case let .buttonPress(button):
      return .shortButtonPress(self.button(button))
    }
  }
}

// MARK: - Screenshots

struct IdbScreenshots: ScreenCapturer, @unchecked Sendable {
  let simulator: Simulator

  func capture(scale: Double) async throws -> ScreenCapture {
    let configuration = ScreenshotConfiguration(encoding: .png, scale: scale < 1 ? .factor(scale) : .native)
    return try await IdbErrors.mapping {
      let result = try await simulator.screenshot.take(configuration: configuration)
      return ScreenCapture(imageData: result.imageData, size: result.size)
    }
  }
}

// MARK: - Apps

struct IdbApps: AppLifecycle, @unchecked Sendable {
  let simulator: Simulator

  func launch(_ spec: AppLaunchSpec) async throws -> pid_t {
    let configuration = ApplicationLaunchConfiguration(
      bundleID: spec.bundleID, bundleName: nil, arguments: spec.arguments, environment: spec.environment,
      waitForDebugger: false, launchMode: Self.launchMode(terminateRunning: spec.terminateRunning))
    return try await IdbErrors.mapping { try await simulator.application.launch(configuration).processIdentifier }
  }

  func terminate(bundleID: String) async throws {
    try await IdbErrors.mapping { try await simulator.application.kill(bundleID: bundleID) }
  }

  func processID(bundleID: String) async throws -> pid_t {
    try await IdbErrors.mapping { try await simulator.application.processID(forBundleID: bundleID) }
  }

  func open(url: URL) async throws {
    try await IdbErrors.mapping { try await simulator.lifecycle.open(url) }
  }

  static func launchMode(terminateRunning: Bool) -> ApplicationLaunchMode {
    terminateRunning ? .relaunchIfRunning : .foregroundIfRunning
  }
}

// MARK: - Orientation

struct IdbOrientation: OrientationControl, @unchecked Sendable {
  let simulator: Simulator

  func current() async throws -> DeviceOrientation {
    let value = try await IdbErrors.mapping { try await simulator.orientation.current() }
    return Self.orientation(value)
  }

  static func orientation(_ value: SimulatorDeviceOrientation) -> DeviceOrientation {
    switch value {
    case .portrait: return .portrait
    case .portraitUpsideDown: return .portraitUpsideDown
    case .landscapeLeft: return .landscapeLeft
    case .landscapeRight: return .landscapeRight
    case .faceUp: return .faceUp
    case .faceDown: return .faceDown
    case .unknown: return .unknown
    @unknown default: return .unknown
    }
  }

  /// Writes through the public HID command (`.device` convention, the one `current()` reads), so a runtime that
  /// cannot read orientation can still be rotated.
  func set(_ orientation: DeviceOrientation) async throws {
    let hid = try Self.hidOrientation(orientation)
    try await IdbErrors.mapping { try await simulator.orientation.set(hid, convention: .device) }
  }

  /// `SimulatorDeviceOrientation.hidOrientation` is internal to FBSimulatorControl, so the four writable cases are
  /// mapped here.
  static func hidOrientation(_ orientation: DeviceOrientation) throws -> SimulatorHIDDeviceOrientation {
    switch orientation {
    case .portrait: return .portrait
    case .portraitUpsideDown: return .portraitUpsideDown
    case .landscapeLeft: return .landscapeLeft
    case .landscapeRight: return .landscapeRight
    case .unknown, .faceUp, .faceDown:
      throw WireError(.badRequest, "orientation \(orientation.rawValue) cannot be set")
    }
  }
}
