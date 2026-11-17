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

/// One booted simulator, opened through a backend (`IdbBackend`): its capabilities behind the seams in `Seams.swift` (HID,
/// screenshots, app lifecycle, orientation, the AX readers). Ops receive it as their context.
final class Session: @unchecked Sendable {
  let udid: String
  let device: any DeviceInfo
  /// Caller-owned HID connection (negotiated transport unless `--hid` forced one). Used by the HID ops.
  let hid: any HIDSender
  let screenshots: any ScreenCapturer
  let apps: any AppLifecycle
  let orientationControl: any OrientationControl
  let hidTransport: String
  let axDefault: String
  /// The in-guest reader (`.exclusive` persistence, automation mode on): a guest this process owns, never the
  /// simulator's shared one, which went stale across helper runs and left quiescence streams stuck. Nil when it
  /// could not be constructed.
  let axBridgeReader: (any AXReader)?
  /// The host-side accessibility reader (`ax`), the per-request fallback.
  let axHostReader: (any AXReader)?
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
  /// Whether the guest has answered since it last went cold (start, recycle, launch); cold reads get the longer deadline.
  let bridgeWarmth = BridgeWarmth()
  /// The background check that ends a stall cooldown once the guest answers again (`BridgeProbe`).
  let bridgeProbe = BridgeProbe()
  /// Recycles a guest that stalled after it had answered, a few times per helper (`BridgeReaper`,
  /// `WARDEN_SIMD_BRIDGE_MAX_RECYCLES`); set in `init`.
  private(set) var bridgeReaper = BridgeReaper(maxRecycles: 0) { 0 }
  /// Restarts backboardd when both readers go silent on a wedged accessibility server (`AXWedgeRecovery`,
  /// `WARDEN_SIMD_AX_WEDGE_RESTARTS`); set in `init`.
  private(set) var axWedgeRecovery = AXWedgeRecovery.off
  /// The per-read bridge deadline and the cooldown after a stall (`WARDEN_SIMD_BRIDGE_DEADLINE_MS` / `_COOLDOWN_S`).
  let bridgeDeadline = BridgeDeadline.configured()
  /// When the frontmost lookup last failed, so reads go by pid for `frontmostPolicy.cooldownSeconds`.
  let frontmostGate = FrontmostLookupGate()
  /// The guest's frontmost strategy and the pid-read cooldown (`WARDEN_SIMD_FRONTMOST_METHOD` / `_COOLDOWN_S`).
  let frontmostPolicy = FrontmostPolicy.configured()
  /// The pid each bundle id last resolved to, for `frontmost`.
  let bundlePids = BundlePidMemory()
  let orientationMemory = OrientationMemory()
  let interfaceMemory = InterfaceMemory()
  /// Text-field placeholders the bridge leaves out, learned from the host reader (`PlaceholderFill`).
  let placeholderMemory = PlaceholderMemory()

  init(
    udid: String, backend: DeviceBackend, axDefault: String, resourcesDirectory: String,
    startedAt: ContinuousClock.Instant
  ) {
    self.udid = udid
    self.device = backend.device
    self.hid = backend.hid
    self.screenshots = backend.screenshots
    self.apps = backend.apps
    self.orientationControl = backend.orientation
    self.hidTransport = backend.hidTransport
    self.axDefault = axDefault
    self.axBridgeReader = backend.axBridge
    self.axHostReader = backend.axHost
    self.bridge = backend.bridge
    self.coreSimulatorVersion = backend.coreSimulatorVersion
    self.resourcesDirectory = resourcesDirectory
    self.startedAt = startedAt
    self.bridgeReaper = BridgeReaper(
      maxRecycles: BridgeReaper.configuredMaxRecycles(log: { OpLog.shared.log(.warn, $0, op: "start") }),
      recycle: { [weak self] in await self?.recycleStalledGuest() ?? 0 },
      rewarm: { [weak self] in self?.warmBridge() })
    self.axWedgeRecovery = AXWedgeRecovery(
      maxRestarts: AXWedgeRecovery.configuredMaxRestarts(log: { OpLog.shared.log(.warn, $0, op: "start") }),
      steps: axWedgeSteps(), log: { OpLog.shared.log(.warn, $0, op: "axWedge") })
  }

  /// Opens the simulator through `IdbBackend` and wraps it. Throws `WireError` (`E_UNKNOWN_UDID`, `E_NOT_BOOTED`,
  /// `E_HID`, `E_INTERNAL`).
  static func open(udid: String, options: SessionOptions) async throws -> Session {
    let startedAt = ContinuousClock.now
    let backend = try await IdbBackend.open(udid: udid, options: options)
    return Session(
      udid: udid, backend: backend, axDefault: options.ax?.rawValue ?? "axbridge", resourcesDirectory: options.resources,
      startedAt: startedAt)
  }

  func close() async {
    await quiescence.stop()
    await hid.close()
  }

  /// Screen size in portrait-up points and scale. AX frames and HID points are in the interface space, which swaps
  /// these axes while the frontmost app draws landscape (`InterfaceOrientation`).
  var screen: (width: Double, height: Double, scale: Double) {
    guard let info = device.screenInfo, info.scale > 0 else { return (0, 0, 0) }
    let scale = info.scale
    return (Double(info.widthPixels) / scale, Double(info.heightPixels) / scale, scale)
  }

  var uptimeMs: Int {
    let components = (ContinuousClock.now - startedAt).components
    return Int(components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000)
  }
}
