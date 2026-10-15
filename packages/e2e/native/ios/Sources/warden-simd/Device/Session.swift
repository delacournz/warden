import FBControlCore
import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import Foundation

struct SessionOptions: Sendable {
  var resources: String
  var hid: Arguments.HIDChoice?
  var ax: Arguments.AXChoice?
}

/// What the in-sim AX bridge guest looks like from here.
enum BridgeStatus: Sendable, Equatable {
  /// `SimulatorFrameworkBridge-iOS` is in `Resources/` and the reader was constructed.
  case available
  /// The guest binary is not in `Resources/`.
  case missing
  /// The reader could not be constructed (or a probe read failed).
  case failed(String)

  var name: String {
    switch self {
    case .available: return "available"
    case .missing: return "missing"
    case .failed: return "failed"
    }
  }
}

/// One booted simulator, opened through idb's FBSimulatorControl: the simulator handle, a HID connection, and the AX
/// readers (`axbridge` shared guest + host-side `ax`). Ops receive it as their context.
final class Session: @unchecked Sendable {
  let udid: String
  let simulator: Simulator
  /// Caller-owned HID connection (negotiated transport unless `--hid` forced one). Used by the HID ops.
  let hid: SimulatorHIDSession
  let hidTransport: String
  let axDefault: String
  /// The in-guest reader (`.shared` persistence, automation mode on); nil when it could not be constructed.
  let axBridgeReader: (any UIAutomation)?
  /// The host-side accessibility reader (`ax`), the per-request fallback.
  let axHostReader: (any UIAutomation)?
  let bridge: BridgeStatus
  let coreSimulatorVersion: String?
  let resourcesDirectory: String
  let startedAt: ContinuousClock.Instant

  init(
    udid: String, simulator: Simulator, hid: SimulatorHIDSession, hidTransport: String, axDefault: String,
    axBridgeReader: (any UIAutomation)?, axHostReader: (any UIAutomation)?, bridge: BridgeStatus,
    coreSimulatorVersion: String?, resourcesDirectory: String, startedAt: ContinuousClock.Instant
  ) {
    self.udid = udid
    self.simulator = simulator
    self.hid = hid
    self.hidTransport = hidTransport
    self.axDefault = axDefault
    self.axBridgeReader = axBridgeReader
    self.axHostReader = axHostReader
    self.bridge = bridge
    self.coreSimulatorVersion = coreSimulatorVersion
    self.resourcesDirectory = resourcesDirectory
    self.startedAt = startedAt
  }

  /// Bootstraps FBSimulatorControl, requires the simulator to be booted, connects HID, builds the AX readers.
  /// Throws `WireError` (`E_UNKNOWN_UDID`, `E_NOT_BOOTED`, `E_HID`, `E_INTERNAL`).
  static func open(udid: String, options: SessionOptions) async throws -> Session {
    let startedAt = ContinuousClock.now
    // The guest binary + shims live next to the executable (or wherever --resources points).
    BundledResources.hostDirectoryPath = options.resources

    let bootstrap: SimulatorControlBootstrap
    do {
      bootstrap = try SimulatorControlBootstrap.withConfiguration(
        SimulatorControlConfiguration(deviceSetPath: nil, logger: nil))
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
    let hid: SimulatorHIDSession
    do {
      hid = try await SimulatorHIDSession.open(simulator, transport: forced)
    } catch {
      throw WireError(.hid, "could not connect HID: \(error.localizedDescription)")
    }
    let transport = options.hid?.rawValue ?? negotiatedTransport(coreSimulatorVersion: coreSimulatorVersion)

    var bridge: BridgeStatus = .available
    var bridgeReader: (any UIAutomation)?
    if BundledResources.path(forItem: "SimulatorFrameworkBridge-iOS") == nil {
      bridge = .missing
    } else {
      do {
        bridgeReader = try simulator.uiAutomation(
          backend: .axBridge(persistence: .shared, frontmostMethod: .windowServer, automationMode: true))
      } catch {
        bridge = .failed(error.localizedDescription)
      }
    }
    let hostReader = try? simulator.uiAutomation(backend: .accessibility)

    return Session(
      udid: udid, simulator: simulator, hid: hid, hidTransport: transport,
      axDefault: options.ax?.rawValue ?? "axbridge", axBridgeReader: bridgeReader, axHostReader: hostReader,
      bridge: bridge, coreSimulatorVersion: coreSimulatorVersion, resourcesDirectory: options.resources,
      startedAt: startedAt)
  }

  func close() async {
    await hid.close()
  }

  /// Screen size in portrait-up points (the AX frame space) and scale.
  var screen: (width: Double, height: Double, scale: Double) {
    guard let info = simulator.screenInfo, info.scale > 0 else { return (0, 0, 0) }
    let scale = Double(info.scale)
    return (Double(info.widthPixels) / scale, Double(info.heightPixels) / scale, scale)
  }

  var uptimeMs: Int {
    let components = (ContinuousClock.now - startedAt).components
    return Int(components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000)
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

extension WireError {
  /// Maps anything an op can throw onto a wire error. idb errors keep their meaning: AX failures are
  /// `E_AX_UNAVAILABLE` / `E_APP_*`, HID failures `E_HID`, "nothing there" `E_NO_ELEMENT`.
  static func from(_ error: any Error) -> WireError {
    if let wire = error as? WireError { return wire }
    if error is CancellationError { return WireError(.internal, "operation cancelled") }
    if let error = error as? UIAutomationError { return from(automation: error) }
    if let error = error as? AXBridgeError { return from(bridge: error) }
    if error is SimulatorHIDError {
      return WireError(.hid, error.localizedDescription, detail: ["kind": "SimulatorHIDError"])
    }
    let nsError = error as NSError
    if nsError.domain == NSCocoaErrorDomain || nsError.domain == NSPOSIXErrorDomain {
      return WireError(.io, nsError.localizedDescription)
    }
    return WireError(.internal, error.localizedDescription)
  }

  private static func from(automation error: UIAutomationError) -> WireError {
    let message = error.localizedDescription
    switch error {
    case .elementNotFound, .elementNotOnScreen, .frameUnavailable, .noElementAtPoint, .valueMismatch:
      return WireError(.noElement, message)
    case .elementMoved:
      return WireError(.noElement, message, retryable: true)
    case .timedOut:
      return WireError(.timeout, message)
    case .markerRequired, .pointOrMarkerRequired, .invalidPollInterval, .traversalCannotAnswer,
      .clientNeedsTranslatorVocabulary:
      return WireError(.badRequest, message)
    case .operationUnsupported:
      return WireError(.unsupported, message)
    case let .applicationUnavailable(_, pid, bundleID):
      return WireError(.appUnavailable, message, detail: appDetail(pid: pid, bundleID: bundleID))
    case let .applicationNotResponding(_, pid, bundleID):
      return WireError(.appNotResponding, message, detail: appDetail(pid: pid, bundleID: bundleID))
    case .writeUnconfirmed:
      return WireError(.internal, message)
    @unknown default:
      return WireError(.internal, message)
    }
  }

  private static func from(bridge error: AXBridgeError) -> WireError {
    let message = error.localizedDescription
    switch error {
    case let .applicationUnavailable(pid):
      return WireError(.appUnavailable, message, detail: appDetail(pid: pid, bundleID: nil))
    case let .applicationNotResponding(pid):
      return WireError(.appNotResponding, message, detail: appDetail(pid: pid, bundleID: nil))
    case .assertionFailed:
      return WireError(.noElement, message)
    case .bridgeUnavailable, .readerUnavailable, .frontmostUnresolved, .socketPathTooLong, .guestDiedBeforeBinding,
      .guestFailure:
      return WireError(.axUnavailable, message)
    @unknown default:
      return WireError(.axUnavailable, message)
    }
  }

  private static func appDetail(pid: pid_t?, bundleID: String?) -> JSON? {
    var fields: [String: JSON] = [:]
    if let pid { fields["pid"] = .int(Int(pid)) }
    if let bundleID { fields["bundleId"] = .string(bundleID) }
    return fields.isEmpty ? nil : .object(fields)
  }
}
