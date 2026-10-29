import UIKit
import XCTest

/// Collects the issues XCTest records while an op runs. With `continueAfterFailure = true` a failed `typeText` or `tap`
/// records an issue instead of ending `testServe`; the executor turns those into one wire error (`ErrorClassifier`).
final class IssueCollector: NSObject, XCTestObservation {
  var messages: [String] = []

  func testCase(_ testCase: XCTestCase, didRecord issue: XCTIssue) {
    messages.append(issue.compactDescription)
  }
}

/// `warden-runner`'s op map, on the public XCUITest API only. One instance, used from the main run loop: every call
/// blocks until the device answered, which is what serialises ops.
final class XCUIExecutor: CommandExecutor {
  static let springboardId = "com.apple.springboard"

  private let issues: IssueCollector
  private let started = Date()
  private var apps: [String: XCUIApplication] = [:]
  /// The app the last `launch` started: the default target of snapshots and input.
  private var activeBundleId: String?
  private(set) var isShutdown = false
  var readyFields: () -> [String: JSON] = { [:] }

  init(issues: IssueCollector) {
    self.issues = issues
  }

  private func app(_ bundleId: String) -> XCUIApplication {
    if let existing = apps[bundleId] { return existing }
    let created = XCUIApplication(bundleIdentifier: bundleId)
    apps[bundleId] = created
    return created
  }

  private func target(_ bundleId: String?) -> XCUIApplication {
    app(bundleId ?? activeBundleId ?? Self.springboardId)
  }

  // MARK: geometry

  var deviceOrientation: DeviceOrientation {
    DeviceOrientation(uiDeviceOrientationRaw: XCUIDevice.shared.orientation.rawValue)
  }

  private var scale: Double { Double(UIScreen.main.scale) }

  /// Frame space of an app whose root frame is `rootFrame`. The device orientation is only read when it can matter:
  /// a landscape root frame, or an iPad (which can be upside down).
  func space(rootFrame: Rect) -> FrameSpace {
    let needsOrientation = rootFrame.width > rootFrame.height || UIDevice.current.userInterfaceIdiom == .pad
    return FrameSpace.resolve(device: needsOrientation ? deviceOrientation : .portrait, rootFrame: rootFrame)
  }

  func space(of app: XCUIApplication) -> FrameSpace {
    let frame = app.frame
    return space(rootFrame: Rect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height))
  }

  func screen() -> RunnerInfo.Screen {
    let space = space(of: app(Self.springboardId))
    return RunnerInfo.Screen(width: space.width, height: space.height, scale: scale)
  }

  // MARK: dispatch

  func execute(_ command: RunnerCommand, op: String) -> Result<JSON, WireError> {
    issues.messages.removeAll()
    var result: Result<JSON, WireError> = .failure(WireError(.internal, "\(op) did not run"))
    // A raised NSException (typing with no keyboard focus, a vanished app) would otherwise end testServe.
    let raised = WardenCatch {
      do {
        result = .success(try self.run(command))
      } catch {
        result = .failure(ErrorClassifier.classify(op: op, error: error))
      }
    }
    if let raised {
      issues.messages.removeAll()
      return .failure(ErrorClassifier.classify(op: op, messages: ["\(raised.name.rawValue): \(raised.reason ?? "no reason")"]))
    }
    if !issues.messages.isEmpty {
      let failure = ErrorClassifier.classify(op: op, messages: issues.messages)
      issues.messages.removeAll()
      return .failure(failure)
    }
    return result
  }

  private func run(_ command: RunnerCommand) throws -> JSON {
    switch command {
    case .health:
      return RunnerInfo.health(
        fields: readyFields(), uptimeMs: Int(Date().timeIntervalSince(started) * 1000), state: "serving")
    case let .snapshot(params): return try snapshot(params)
    case let .tap(point, count, holdMs, bundleId): return tap(point, count: count, holdMs: holdMs, bundleId: bundleId)
    case let .longPress(point, durationMs, bundleId):
      return tap(point, count: 1, holdMs: durationMs, bundleId: bundleId, longPress: true)
    case let .swipe(from, to, durationMs, bundleId):
      return drag(from: from, to: to, pressMs: 50, durationMs: durationMs, releaseMs: 0, bundleId: bundleId)
    case let .drag(from, to, pressMs, durationMs, releaseMs, bundleId):
      return drag(from: from, to: to, pressMs: pressMs, durationMs: durationMs, releaseMs: releaseMs, bundleId: bundleId)
    case let .typeText(text, bundleId):
      if !text.isEmpty {
        let application = target(bundleId)
        try requireKeyboardFocus(application)
        application.typeText(text)
      }
      return ["typed": .int(text.unicodeScalars.count)]
    case let .key(spec, bundleId):
      try requireKeyboardFocus(target(bundleId))
      return key(spec, bundleId: bundleId)
    case let .pressButton(button):
      switch button {
      case .home: XCUIDevice.shared.press(.home)
      case .volumeUp: XCUIDevice.shared.press(.volumeUp)
      case .volumeDown: XCUIDevice.shared.press(.volumeDown)
      }
      return [:]
    case let .screenshot(scale): return screenshot(scale: scale)
    case .orientation: return ["orientation": .string(deviceOrientation.rawValue), "source": "device"]
    case .alertButtons: return try alertButtons()
    case let .frontmost(bundleId): return ["frontmost": .bool(app(bundleId).state == .runningForeground)]
    case let .appState(bundleId): return ["state": .string(Self.stateName(app(bundleId).state))]
    case let .launch(params): return launch(params)
    case let .terminate(bundleId): return terminate(bundleId)
    case let .openUrl(url): return try openUrl(url)
    case .shutdown:
      isShutdown = true
      return [:]
    }
  }

  // MARK: reads

  private func snapshot(_ params: SnapshotParams) throws -> JSON {
    let application = target(params.bundleId)
    guard application.state != .notRunning else {
      throw WireError(
        .appUnavailable, "\(params.bundleId ?? activeBundleId ?? "the app") is not running",
        detail: ["bundleId": .string(params.bundleId ?? activeBundleId ?? Self.springboardId)])
    }
    let began = Date()
    let snapshot = try application.snapshot()
    let root = Self.rawNode(snapshot)
    let readMs = Date().timeIntervalSince(began) * 1000
    let space = space(rootFrame: root.frame)
    let output = SnapshotEncoder.build(root: root, space: space, options: params.options)
    let info = RunnerInfo.Screen(width: space.width, height: space.height, scale: scale)
    let fallback: JSON? =
      params.axbridgeRequested
      ? ["from": "axbridge", "to": "ax", "reason": "a physical device has no AX bridge; read through XCUITest"] : nil
    return SnapshotEncoder.snapshotData(output, screen: info, ms: readMs, fallback: fallback)
  }

  private static func rawNode(_ snapshot: XCUIElementSnapshot) -> RawNode {
    let frame = snapshot.frame
    var value: String?
    if let raw = snapshot.value {
      value = (raw as? String) ?? String(describing: raw)
    }
    return RawNode(
      type: elementTypeName(snapshot.elementType),
      label: snapshot.label,
      identifier: snapshot.identifier,
      value: value,
      placeholder: snapshot.placeholderValue,
      frame: Rect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height),
      enabled: snapshot.isEnabled,
      selected: snapshot.isSelected,
      hasFocus: snapshot.hasFocus,
      children: snapshot.children.map(rawNode)
    )
  }

  private func alertButtons() throws -> JSON {
    var candidates = [Self.springboardId]
    if let active = activeBundleId { candidates.append(active) }
    for bundleId in candidates {
      let application = app(bundleId)
      let alert = application.alerts.firstMatch
      guard alert.exists else { continue }
      let snapshot = try alert.snapshot()
      return SnapshotEncoder.alertData(from: Self.rawNode(snapshot), space: space(of: application))
    }
    return .null
  }

  private func screenshot(scale requested: Double) -> JSON {
    let shot = XCUIScreen.main.screenshot()
    var image = shot.image
    var png = shot.pngRepresentation
    if requested < 1 {
      let size = CGSize(width: image.size.width * requested, height: image.size.height * requested)
      let format = UIGraphicsImageRendererFormat()
      format.scale = image.scale
      let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        image.draw(in: CGRect(origin: .zero, size: size))
      }
      image = rendered
      png = rendered.pngData() ?? png
    }
    return [
      "png": .string(png.base64EncodedString()),
      "width": .int(Int((image.size.width * image.scale).rounded())),
      "height": .int(Int((image.size.height * image.scale).rounded())),
    ]
  }

  // MARK: input

  /// Typing with no keyboard focus makes XCTest record a failure, and a recorded failure ends `testServe` shortly after
  /// (PHY-3 device smoke: the listener died two ops later, even with `continueAfterFailure` and the exception catch).
  /// So the runner never lets that happen: it asks first and answers `E_NO_ELEMENT` itself.
  private func requireKeyboardFocus(_ application: XCUIApplication) throws {
    let focused = application.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
    guard focused.exists else {
      throw WireError(.noElement, "no element has keyboard focus; tap a text field first")
    }
  }

  /// A coordinate in interface space: the origin of `application` plus the portrait-up point converted back.
  private func coordinate(_ point: Target, in application: XCUIApplication) -> XCUICoordinate {
    let space = space(of: application)
    let portrait = point.resolve(width: space.width, height: space.height)
    let local = space.toInterface(portrait)
    return application.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: local.x, dy: local.y))
  }

  private func tap(_ point: Target, count: Int, holdMs: Int, bundleId: String?, longPress: Bool = false) -> JSON {
    let coordinate = coordinate(point, in: target(bundleId))
    if longPress || holdMs > 0 {
      coordinate.press(forDuration: Double(holdMs) / 1000)
    } else if count == 2 {
      coordinate.doubleTap()
    } else {
      for _ in 0..<count { coordinate.tap() }
    }
    return [:]
  }

  private func drag(from: Target, to: Target, pressMs: Int, durationMs: Int, releaseMs: Int, bundleId: String?) -> JSON {
    let application = target(bundleId)
    let start = coordinate(from, in: application)
    let end = coordinate(to, in: application)
    let space = space(of: application)
    let a = from.resolve(width: space.width, height: space.height)
    let b = to.resolve(width: space.width, height: space.height)
    let distance = hypot(b.x - a.x, b.y - a.y)
    let velocity = durationMs > 0 ? distance / (Double(durationMs) / 1000) : 5000
    start.press(
      forDuration: Double(pressMs) / 1000, thenDragTo: end, withVelocity: XCUIGestureVelocity(max(velocity, 50)),
      thenHoldForDuration: Double(releaseMs) / 1000)
    return [:]
  }

  private func key(_ spec: KeySpec, bundleId: String?) -> JSON {
    var flags: XCUIElement.KeyModifierFlags = []
    for modifier in spec.modifiers {
      switch modifier {
      case .shift: flags.insert(.shift)
      case .cmd: flags.insert(.command)
      case .alt: flags.insert(.option)
      case .ctrl: flags.insert(.control)
      }
    }
    let application = target(bundleId)
    switch spec.key {
    case let .character(character): application.typeKey(character, modifierFlags: flags)
    case let .named(named): application.typeKey(Self.keyboardKey(named), modifierFlags: flags)
    }
    return [:]
  }

  private static func keyboardKey(_ key: NamedKey) -> XCUIKeyboardKey {
    switch key {
    case .enter: return .return
    case .escape: return .escape
    case .delete: return .delete
    case .forwardDelete: return .forwardDelete
    case .tab: return .tab
    case .space: return .space
    case .upArrow: return .upArrow
    case .downArrow: return .downArrow
    case .leftArrow: return .leftArrow
    case .rightArrow: return .rightArrow
    case .home: return .home
    case .end: return .end
    case .pageUp: return .pageUp
    case .pageDown: return .pageDown
    }
  }

  // MARK: apps

  private func launch(_ params: LaunchParams) -> JSON {
    let application = app(params.bundleId)
    application.launchArguments = params.arguments
    application.launchEnvironment = params.environment
    if params.terminateRunning || application.state == .notRunning {
      if application.state != .notRunning { application.terminate() }
      application.launch()
    } else {
      application.activate()
    }
    activeBundleId = params.bundleId
    // Public XCUITest exposes no process id; the schema needs a number, so 0 says "unknown".
    return ["pid": 0]
  }

  private func terminate(_ bundleId: String) -> JSON {
    let application = app(bundleId)
    let wasRunning = application.state != .notRunning
    if wasRunning { application.terminate() }
    if activeBundleId == bundleId { activeBundleId = nil }
    return ["terminated": .bool(wasRunning)]
  }

  private func openUrl(_ url: URL) throws -> JSON {
    XCUIDevice.shared.system.open(url)
    return [:]
  }

  private static func stateName(_ state: XCUIApplication.State) -> String {
    switch state {
    case .notRunning: return "notRunning"
    case .runningBackgroundSuspended: return "runningBackgroundSuspended"
    case .runningBackground: return "runningBackground"
    case .runningForeground: return "runningForeground"
    default: return "unknown"
    }
  }
}
