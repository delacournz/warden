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

/// Whether the last `axbridge` read worked. `health` without a probe would otherwise say `available` for as long as
/// the resource exists, however many reads failed since.
final class BridgeHealth: @unchecked Sendable {
  struct Failure: Equatable {
    var message: String
    var at: Double
  }

  private let lock = NSLock()
  private var failure: Failure?

  func recordFailure(_ message: String, at now: Double = ProcessInfo.processInfo.systemUptime) {
    lock.withLock { failure = Failure(message: message, at: now) }
  }

  func recordSuccess() {
    lock.withLock { failure = nil }
  }

  var lastFailure: Failure? { lock.withLock { failure } }
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
  /// The in-guest reader (`.exclusive` persistence, automation mode on): a guest this process owns, never the
  /// simulator's shared one, which went stale across helper runs and left quiescence streams stuck. Nil when it
  /// could not be constructed.
  let axBridgeReader: (any UIAutomation)?
  /// The host-side accessibility reader (`ax`), the per-request fallback.
  let axHostReader: (any UIAutomation)?
  let bridge: BridgeStatus
  let coreSimulatorVersion: String?
  let resourcesDirectory: String
  let startedAt: ContinuousClock.Instant
  /// Set by socket mode so `health` can report the listener and its clients.
  let socket = SocketStatus()
  /// Long-lived quiescence stream backing `settle`; created on first use.
  let quiescence = QuiescenceHolder()
  /// The last `axbridge` read failure that was not repaired, for `health`.
  let bridgeHealth = BridgeHealth()
  /// When the bridge last stalled (a read past `bridgeDeadline.readMs`), so the reads inside the cooldown go to `ax`.
  let bridgeStall = BridgeStallGate()
  /// The per-read bridge deadline and the cooldown after a stall (`WARDEN_SIMD_BRIDGE_DEADLINE_MS` / `_COOLDOWN_S`).
  let bridgeDeadline = BridgeDeadline.configured()
  /// When the frontmost lookup last failed, so reads go by pid for `frontmostPolicy.cooldownSeconds`.
  let frontmostGate = FrontmostLookupGate()
  /// The guest's frontmost strategy and the pid-read cooldown (`WARDEN_SIMD_FRONTMOST_METHOD` / `_COOLDOWN_S`).
  let frontmostPolicy = FrontmostPolicy.configured()
  /// The pid each bundle id last resolved to, for `frontmost`.
  let bundlePids = BundlePidMemory()
  let orientationMemory = OrientationMemory()

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
          backend: .axBridge(
            persistence: .exclusive, frontmostMethod: FrontmostPolicy.configured().method, automationMode: true))
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
    await quiescence.stop()
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
    if let both = error as? AXReadersFailed {
      let host = from(both.host)
      var fields = host.detail?.objectValue ?? [:]
      fields["bridgeError"] = .string(both.bridgeReason)
      if fields["axError"] == nil { fields["axError"] = .string(host.message) }
      return WireError(host.code, both.localizedDescription, retryable: host.retryable, detail: .object(fields))
    }
    if let error = error as? AccessibilityError { return from(accessibility: error) }
    if let stall = error as? BridgeStalled {
      return WireError(.timeout, stall.localizedDescription, detail: ["afterMs": .int(stall.afterMs), "stage": "axbridge"])
    }
    if error is CancellationError { return WireError(.internal, "operation cancelled") }
    if let error = error as? QuiescenceError { return from(quiescence: error) }
    if let error = error as? UIAutomationError { return from(automation: error) }
    if let error = error as? AXBridgeError { return from(bridge: error) }
    if let error = error as? SimulatorApplicationLaunchError { return from(launch: error) }
    if let error = error as? SimulatorLaunchCtlError { return from(launchCtl: error) }
    if let error = error as? SimulatorLifecycleError { return from(lifecycle: error) }
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

  /// The host translator (`ax`). A silent service is a retryable timeout; a missing frontmost app says so in
  /// `detail.reason` (`frontmost_unresolved`), which the TS driver records on the snapshot span.
  private static func from(accessibility error: AccessibilityError) -> WireError {
    let message = error.localizedDescription
    var fields: [String: JSON] = ["stage": "ax", "axError": .string(message)]
    if Session.isFrontmostUnresolved(error) { fields["reason"] = "frontmost_unresolved" }
    switch error {
    case let .serviceNotAnswering(silence, elapsed, behind):
      switch silence {
      case let .request(kind, _): fields["request"] = .string(kind)
      case .query: fields["request"] = "query"
      @unknown default: break
      }
      fields["elapsedMs"] = .int(Int(elapsed * 1000))
      if behind > 0 { fields["behindAbandoned"] = .int(Int(behind)) }
      return WireError(.timeout, message, detail: .object(fields))
    case .noTranslationObject, .springBoardRestarting, .springBoardNotRunning, .accessibilityUnavailable,
      .dispatcherUnavailable:
      return WireError(.axUnavailable, message, detail: .object(fields))
    case .simulatorNotBooted:
      return WireError(.notBooted, message)
    case .elementNotFound:
      return WireError(.noElement, message)
    default:
      return WireError(.internal, message, detail: .object(fields))
    }
  }

  private static func from(quiescence error: QuiescenceError) -> WireError {
    let message = error.localizedDescription
    switch error {
    case .timedOut: return WireError(.timeout, message)
    case let .targetExited(pid): return WireError(.appUnavailable, message, detail: appDetail(pid: pid, bundleID: nil))
    case .streamEnded: return WireError(.axUnavailable, message)
    @unknown default: return WireError(.axUnavailable, message)
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
    case let .guestNotAnswering(after):
      return WireError(.timeout, message, detail: .object(["afterSeconds": .double(after)]))
    case .bridgeUnavailable, .readerUnavailable, .frontmostUnresolved, .socketPathTooLong, .guestDiedBeforeBinding,
      .guestFailure:
      return WireError(.axUnavailable, message)
    @unknown default:
      return WireError(.axUnavailable, message)
    }
  }

  /// `launch`: an app that is not installed (or has no data container) is `E_APP_UNAVAILABLE`, like a failed
  /// `simctl launch` of a missing app; the launch mode cases cannot come from a request this helper builds.
  private static func from(launch error: SimulatorApplicationLaunchError) -> WireError {
    let message = error.localizedDescription
    switch error {
    case let .launchingUninstalledApplication(bundleID, _), let .noDataDirectory(bundleID):
      return WireError(.appUnavailable, message, detail: appDetail(pid: nil, bundleID: bundleID))
    case let .applicationAlreadyRunning(bundleID, pid):
      return WireError(.internal, message, detail: appDetail(pid: pid, bundleID: bundleID))
    case .foregroundIfRunningIncompatibleWithWaitForDebugger:
      return WireError(.badRequest, message)
    @unknown default:
      return WireError(.internal, message)
    }
  }

  /// launchd inside the simulator: no process for the bundle is `E_APP_UNAVAILABLE`, anything else `E_IO`.
  private static func from(launchCtl error: SimulatorLaunchCtlError) -> WireError {
    let message = error.localizedDescription
    switch error {
    case .noMatchingProcesses: return WireError(.appUnavailable, message)
    default: return WireError(.io, message)
    }
  }

  /// `openUrl`: a URL the simulator could not open is `E_IO` (nothing handles the scheme, or the open was refused).
  private static func from(lifecycle error: SimulatorLifecycleError) -> WireError {
    let message = error.localizedDescription
    switch error {
    case .openURLFailed: return WireError(.io, message)
    default: return WireError(.internal, message)
    }
  }

  private static func appDetail(pid: pid_t?, bundleID: String?) -> JSON? {
    var fields: [String: JSON] = [:]
    if let pid { fields["pid"] = .int(Int(pid)) }
    if let bundleID { fields["bundleId"] = .string(bundleID) }
    return fields.isEmpty ? nil : .object(fields)
  }
}
