import CoreGraphics
import FBControlCore
import FBSimulatorAX
import FBSimulatorControl
import Foundation

/// `snapshot`, `elementAtPoint`, `alertButtons`, `frontmost`: the read ops (plan WDN-E2E, `warden-simd` protocol v1).
enum SnapshotOps {
  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "snapshot": { session, params in try await session.snapshot(SnapshotRequest(params)) },
    "elementAtPoint": { session, params in try await session.elementAtPoint(PointRequest(params, session: session)) },
    "alertButtons": { session, params in try await session.alertButtons(AlertRequest(params)) },
    "frontmost": { session, params in try await session.frontmost(FrontmostRequest(params)) },
  ]
}

// MARK: - Log sink

/// Where an op's `log` events go. `main.swift` attaches the stdout channel (`OpLog.shared.attach(output)`); until
/// then (unit tests, embedding) lines go to stderr, so nothing ever lands on stdout outside the NDJSON channel.
final class OpLog: @unchecked Sendable {
  static let shared = OpLog()

  private let lock = NSLock()
  private var channel: OutputChannel?

  func attach(_ channel: OutputChannel) {
    lock.withLock { self.channel = channel }
  }

  func log(_ level: LogLevel, _ message: String, op: String) {
    if let channel = lock.withLock({ channel }) {
      channel.log(level, message, op: op)
    } else {
      FileHandle.standardError.write(Data("warden-simd: [\(level.rawValue)] \(op): \(message)\n".utf8))
    }
  }
}

// MARK: - Requests

enum AXBackend: String, Sendable {
  case axbridge
  case ax

  /// The `UIAutomationBackendName` idb reports -> ours.
  init(_ name: UIAutomationBackendName?) {
    self = name == .ax ? .ax : .axbridge
  }
}

/// Exactly the keys the TS `Element` is built from. idb's default set also fetches title / help / role description /
/// subrole / custom actions / content-required, each an extra attribute read per node that nothing here uses.
let wireKeys: Set<AXKeys> = [.label, .value, .uniqueID, .type, .frameDict, .enabled, .pid, .traits, .placeholder, .hidden, .focused]

/// `reachability` / `interactable` ask the guest for per-node hit-testing (the costly part of a read).
private func parseKeys(_ value: JSON?, reachability: Bool) -> Set<AXKeys> {
  var keys = wireKeys
  for name in value?.arrayValue?.compactMap(\.stringValue) ?? [] {
    switch name {
    case "reachability", "hittable": keys.insert(.interactable)
    default: keys.formUnion(AXKeys.requested([name]))
    }
  }
  if reachability { keys.insert(.interactable) }
  return keys
}

private func parseBackend(_ value: JSON?) throws -> AXBackend? {
  guard let value, value != .null else { return nil }
  guard let name = value.stringValue, let backend = AXBackend(rawValue: name) else {
    throw WireError(.badRequest, "backend must be \"axbridge\" or \"ax\"")
  }
  return backend
}

struct SnapshotRequest: Sendable {
  var interactiveOnly = false
  var backend: AXBackend?
  var keys: Set<AXKeys> = wireKeys
  var maxDepth: Int?
  var maxNodes: Int?
  /// Debug: also return idb's own serialized document as `raw` (used to capture test fixtures).
  var raw = false
  /// Debug: read this process instead of the frontmost app (e.g. SpringBoard's pid, to see system prompts).
  var pid: pid_t?

  init(_ params: JSON) throws {
    pid = params["pid"]?.intValue.map { pid_t($0) }
    interactiveOnly = params["interactiveOnly"]?.boolValue ?? false
    backend = try parseBackend(params["backend"])
    keys = parseKeys(params["keys"], reachability: params["reachability"]?.boolValue ?? false)
    maxDepth = params["maxDepth"]?.intValue
    maxNodes = params["maxNodes"]?.intValue
    raw = params["raw"]?.boolValue ?? false
    if let maxDepth, maxDepth < 1 { throw WireError(.badRequest, "maxDepth must be >= 1") }
    if let maxNodes, maxNodes < 1 { throw WireError(.badRequest, "maxNodes must be >= 1") }
  }

  init() {}
}

struct PointRequest: Sendable {
  var point: CGPoint
  var backend: AXBackend?
  var keys: Set<AXKeys>

  init(_ params: JSON, session: Session) throws {
    guard let x = params["x"]?.doubleValue, let y = params["y"]?.doubleValue else {
      throw WireError(.badRequest, "elementAtPoint needs numeric x and y")
    }
    let size = session.screen
    if params["unit"]?.stringValue == "norm" {
      point = CGPoint(x: x * size.width, y: y * size.height)
    } else {
      point = CGPoint(x: x, y: y)
    }
    backend = try parseBackend(params["backend"])
    keys = parseKeys(params["keys"], reachability: params["reachability"]?.boolValue ?? false)
  }
}

// MARK: - Backend selection

/// Why a read moved from `axbridge` to `ax`.
struct Fallback: Sendable {
  var reason: String
}

struct AXOutcome<Value: Sendable>: Sendable {
  var value: Value
  var backend: AXBackend
  var fallback: Fallback?
}

extension Session {
  /// Failures that mean "the in-guest bridge cannot answer right now", where the host `ax` reader still may.
  static func isBridgeFailure(_ error: any Error) -> Bool {
    if let error = error as? AXBridgeError {
      switch error {
      case .bridgeUnavailable, .readerUnavailable, .frontmostUnresolved, .applicationUnavailable,
        .applicationNotResponding, .guestDiedBeforeBinding, .guestFailure:
        return true
      default:
        return false
      }
    }
    if let error = error as? UIAutomationError {
      switch error {
      case .applicationUnavailable, .applicationNotResponding: return true
      default: return false
      }
    }
    return false
  }

  /// The app answered nothing in time (as opposed to being gone): what an app relaunched while no quiescence
  /// stream was open looks like to the bridge.
  static func isNotResponding(_ error: any Error) -> Bool {
    if let error = error as? AXBridgeError, case .applicationNotResponding = error { return true }
    if let error = error as? UIAutomationError, case .applicationNotResponding = error { return true }
    return false
  }

  /// Runs `read`; when the app did not respond, runs `recover` (a fresh quiescence stream, see
  /// `QuiescenceMonitor.recover`) and reads once more. Any other failure, and a second failure, propagate.
  static func readRecovering<Value>(
    read: () async throws -> Value, recover: () async -> Void, log: (String) -> Void
  ) async throws -> Value {
    do {
      return try await read()
    } catch {
      guard isNotResponding(error) else { throw error }
      log("axbridge: \(WireError.from(error).message); opening a quiescence stream and reading again")
      await recover()
      return try await read()
    }
  }

  /// Gives the guest a stream bound to the current frontmost process. A no-op without a bridge.
  func recoverBridge() async {
    guard let monitor = try? quiescenceMonitor() else { return }
    await monitor.recover(timeoutMs: 4000)
  }

  /// Runs `body` on the requested reader (default: the session's `--ax`, i.e. `axbridge`). With no explicit
  /// `backend`, an `axbridge` read that fails with `bridgeUnavailable` / `applicationUnavailable` /
  /// `applicationNotResponding` (or a bridge that never came up) is retried once on `ax` and a `log` event says so.
  func withAX<Value: Sendable>(
    backend requested: AXBackend?, op: String,
    _ body: @Sendable (any UIAutomation) async throws -> Value
  ) async throws -> AXOutcome<Value> {
    let primary = requested ?? AXBackend(rawValue: axDefault) ?? .axbridge
    if primary == .ax {
      guard let reader = axHostReader else {
        throw WireError(.axUnavailable, "the host accessibility (ax) reader could not be created")
      }
      return AXOutcome(value: try await body(reader), backend: .ax, fallback: nil)
    }

    var reason: String
    if let reader = axBridgeReader {
      do {
        let value = try await Session.readRecovering(
          read: { try await body(reader) },
          recover: { await self.recoverBridge() },
          log: { OpLog.shared.log(.warn, $0, op: op) })
        bridgeHealth.recordSuccess()
        return AXOutcome(value: value, backend: .axbridge, fallback: nil)
      } catch {
        if Session.isBridgeFailure(error) { bridgeHealth.recordFailure(WireError.from(error).message) }
        guard requested == nil, Session.isBridgeFailure(error), axHostReader != nil else { throw error }
        reason = WireError.from(error).message
      }
    } else {
      guard requested == nil, axHostReader != nil else {
        throw WireError(.axUnavailable, "the axbridge reader is unavailable (bridge \(bridge.name))")
      }
      reason = "axbridge reader unavailable (bridge \(bridge.name))"
    }
    OpLog.shared.log(.warn, "axbridge -> ax fallback: \(reason)", op: op)
    let value = try await body(axHostReader!)
    return AXOutcome(value: value, backend: .ax, fallback: Fallback(reason: reason))
  }

  func buildOptions(interactiveOnly: Bool = false, maxDepth: Int? = nil, maxNodes: Int? = nil, document: AccessibilityScreenInfo?)
    -> ElementBuilder.Options
  {
    Session.buildOptions(
      screen: screen, interactiveOnly: interactiveOnly, maxDepth: maxDepth, maxNodes: maxNodes, document: document)
  }

  static func buildOptions(
    screen: (width: Double, height: Double, scale: Double), interactiveOnly: Bool = false, maxDepth: Int? = nil,
    maxNodes: Int? = nil, document: AccessibilityScreenInfo?
  ) -> ElementBuilder.Options {
    var size = screen
    if size.width <= 0, let document { size = (document.width, document.height, size.scale) }
    return ElementBuilder.Options(
      screenWidth: size.width, screenHeight: size.height, interactiveOnly: interactiveOnly, maxDepth: maxDepth,
      maxNodes: maxNodes)
  }

  static func screenJSON(_ size: (width: Double, height: Double, scale: Double)) -> JSON {
    ["width": .double(size.width), "height": .double(size.height), "scale": .double(size.scale)]
  }
}

// MARK: - snapshot

extension Session {
  func snapshot(_ request: SnapshotRequest) async throws -> JSON {
    let started = ContinuousClock.now
    var options = AccessibilityRequestOptions(format: .complete, keys: request.keys)
    options.filter = .all
    let readOptions = options
    let query: AccessibilityElementQuery = request.pid.map { .application(pid: $0) } ?? .frontmost
    var outcome = try await withAX(backend: request.backend, op: "snapshot") { reader in
      try await reader.describe(query, options: readOptions).document
    }
    if request.backend == nil, outcome.backend == .axbridge, Session.isEmptyRoot(outcome.value) {
      outcome = try await recoverEmptyRoot(first: outcome, options: readOptions)
    }
    let document = outcome.value
    let readMs = Session.milliseconds(since: started)
    var data = Session.renderSnapshot(
      document: document, backend: outcome.backend, screen: screen, interactiveOnly: request.interactiveOnly,
      maxDepth: request.maxDepth, maxNodes: request.maxNodes)
    if let fallback = outcome.fallback {
      data["fallback"] = ["from": "axbridge", "to": "ax", "reason": .string(fallback.reason)]
    }
    if request.raw, let encoded = try? JSONEncoder().encode(document),
      let raw = try? JSONDecoder().decode(JSON.self, from: encoded)
    {
      data["raw"] = raw
    }
    data["ms"] = .double(Session.milliseconds(since: started))
    data["readMs"] = .double(readMs)
    data["nodes"] = .int(document.elements.nodeCount)
    return .object(data)
  }

  /// A tree that is one childless node with no area: what the bridge reports when it is bound to an application
  /// that is gone (a relaunched app's old pid), rather than anything an app can draw.
  static func isEmptyRoot(_ document: AccessibilityDocument) -> Bool {
    guard document.elements.count == 1, let root = document.elements.first, (root.children ?? []).isEmpty else {
      return false
    }
    guard let frame = root.frame, let rect = frame else { return true }
    return (rect.width ?? 0) <= 0 || (rect.height ?? 0) <= 0
  }

  /// Reads again on the bridge once after `retryDelay`, then on the host `ax` reader, when the bridge answered with
  /// an empty root. Pure over its closures so a scripted sequence can test it.
  static func recoverFromEmptyRoot(
    first: AXOutcome<AccessibilityDocument>,
    retryDelay: Duration,
    bridgeRead: @Sendable () async throws -> AccessibilityDocument,
    hostRead: (@Sendable () async throws -> AccessibilityDocument)?,
    sleep: @Sendable (Duration) async throws -> Void,
    log: @Sendable (String) -> Void
  ) async throws -> AXOutcome<AccessibilityDocument> {
    log("axbridge returned an empty tree; reading again")
    try await sleep(retryDelay)
    if let again = try? await bridgeRead(), !isEmptyRoot(again) {
      return AXOutcome(value: again, backend: .axbridge, fallback: nil)
    }
    guard let hostRead else { return first }
    let reason = "axbridge returned an empty tree"
    log("axbridge -> ax fallback: \(reason)")
    let document = try await hostRead()
    return AXOutcome(value: document, backend: .ax, fallback: Fallback(reason: reason))
  }

  private func recoverEmptyRoot(
    first: AXOutcome<AccessibilityDocument>, options: AccessibilityRequestOptions
  ) async throws -> AXOutcome<AccessibilityDocument> {
    guard let bridge = axBridgeReader else { return first }
    var hostRead: (@Sendable () async throws -> AccessibilityDocument)?
    if let host = axHostReader {
      hostRead = { @Sendable in try await host.describe(.frontmost, options: options).document }
    }
    let bridgeRead: @Sendable () async throws -> AccessibilityDocument = { @Sendable in
      try await bridge.describe(.frontmost, options: options).document
    }
    let sleep: @Sendable (Duration) async throws -> Void = { @Sendable duration in
      try await Task.sleep(for: duration)
    }
    let log: @Sendable (String) -> Void = { @Sendable message in
      OpLog.shared.log(.warn, message, op: "snapshot")
    }
    return try await Session.recoverFromEmptyRoot(
      first: first, retryDelay: .milliseconds(150), bridgeRead: bridgeRead, hostRead: hostRead, sleep: sleep,
      log: log)
  }

  /// The `snapshot` payload minus timing and diagnostics: pure, so fixtures can drive it without a simulator.
  static func renderSnapshot(
    document: AccessibilityDocument, backend: AXBackend, screen: (width: Double, height: Double, scale: Double),
    interactiveOnly: Bool, maxDepth: Int? = nil, maxNodes: Int? = nil
  ) -> [String: JSON] {
    let built = ElementBuilder.build(
      document.elements,
      options: buildOptions(
        screen: screen, interactiveOnly: interactiveOnly, maxDepth: maxDepth, maxNodes: maxNodes,
        document: document.screen))
    var data: [String: JSON] = [
      "backend": .string(backend.rawValue),
      "screen": screenJSON(screen),
      "truncated": .bool(document.truncated || built.truncated),
      "elements": .array(built.elements.map(\.json)),
    ]
    if let modal = modalJSON(document: document, elements: built.elements) {
      data["modal"] = modal
    }
    return data
  }

  static func milliseconds(since start: ContinuousClock.Instant) -> Double {
    let components = (ContinuousClock.now - start).components
    let ms = Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
    return (ms * 10).rounded() / 10
  }

  /// idb's blocking-modal verdict when it has one; else the frontmost alert / sheet found in the tree.
  static func modalJSON(document: AccessibilityDocument, elements: [Element]) -> JSON? {
    let container = topmostModal(in: elements, modalType: document.modal?.elementType)
    if let modal = document.modal {
      var fields: [String: JSON] = ["description": .string(modal.label ?? modal.elementType)]
      if let pid = container?.pid { fields["pid"] = .int(pid) }
      return .object(fields)
    }
    guard let container else { return nil }
    let firstText = container.preorder.dropFirst().filter { $0.role == .text }.compactMap { $0.text ?? $0.label }.first
    var fields: [String: JSON] = ["description": .string(container.label ?? firstText ?? container.rawType)]
    if let pid = container.pid { fields["pid"] = .int(pid) }
    return .object(fields)
  }

  /// An alert / sheet container: an `Alert` / `Sheet` typed node, a UIKit alert controller view (what the guest
  /// reports for SpringBoard permission prompts), an in-page Safari dialog, or the element type idb named as the
  /// blocking modal.
  static func isModalContainer(_ element: Element, modalType: String?) -> Bool {
    modalRank(element, modalType: modalType) != nil
  }

  /// How strongly a container is "the" alert: 2 = a real alert or dialog (UIKit alert controller, `Alert`, Safari's
  /// `SFDialogView`, idb's named modal), 1 = a sheet, 0 = a popover (a tip or menu, not something that asks a
  /// question). nil = not a modal container.
  static func modalRank(_ element: Element, modalType: String?) -> Int? {
    if element.role == .alert || element.rawType.hasPrefix("_UIAlertController") || element.rawType == "SFDialogView"
      || (modalType != nil && element.rawType == modalType)
    {
      return 2
    }
    guard element.role == .sheet else { return nil }
    return element.label == "Popover" || element.rawType.contains("Popover") ? 0 : 1
  }

  /// The best modal container that offers at least one button: highest rank wins (a Keychain sheet or "Open in ...?"
  /// dialog beats a tip popover drawn over it), and among equals the last in preorder (drawn on top).
  static func topmostModal(in roots: [Element], modalType: String?) -> Element? {
    var best: (rank: Int, element: Element)?
    for element in roots.flatMap(\.preorder) {
      guard let rank = modalRank(element, modalType: modalType), element.preorder.contains(where: { $0.role == .button })
      else { continue }
      if best == nil || rank >= best!.rank { best = (rank, element) }
    }
    return best?.element
  }

  /// The `ax` reader answers `frontmost` with SpringBoard's alert host: an `Application` whose label is blank
  /// and whose children are just the alert's texts and buttons, with no `Alert` node in between.
  static func hostAlertRoot(in roots: [Element]) -> Element? {
    roots.first { root in
      root.role == .application && (root.label ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        && root.preorder.contains { $0.role == .button }
        && root.preorder.dropFirst().allSatisfy { [.text, .button, .textfield, .securefield].contains($0.role) }
    }
  }
}

// MARK: - elementAtPoint

extension Session {
  func elementAtPoint(_ request: PointRequest) async throws -> JSON {
    var options = AccessibilityRequestOptions(format: .complete, keys: request.keys)
    options.filter = .all
    let readOptions = options
    let point = request.point
    let outcome = try await withAX(backend: request.backend, op: "elementAtPoint") { reader -> AccessibilityElementsResponse? in
      do {
        return try await reader.hitTest(at: point, options: readOptions)
      } catch UIAutomationError.noElementAtPoint {
        return nil
      }
    }
    guard let response = outcome.value, let node = response.elements.elements.first else { return .null }
    var element = ElementBuilder.convert(
      node.reportingChildren(), path: "hit", depth: 0,
      options: buildOptions(document: response.screen))
    element.children = []
    return element.json
  }
}

// MARK: - alertButtons

/// `alertButtons{backend?}`. No `backend`: both readers, `ax` first. `ax` / `axbridge`: only that reader.
struct AlertRequest: Sendable, Equatable {
  var backend: AXBackend?

  init(_ params: JSON) throws {
    backend = try parseBackend(params["backend"])
  }

  init(backend: AXBackend? = nil) {
    self.backend = backend
  }
}

extension Session {
  /// The system alert / sheet on top: its buttons (full elements, with `tapPoint`), plus `title` / `message` from its
  /// static texts. `null` when nothing modal is up.
  ///
  /// Without a `backend` both readers are asked, `ax` first because it sees SpringBoard-owned UI (permission prompts),
  /// then `axbridge`, which also sees what an app shows itself (the Keychain sheet): a screen without an alert costs two
  /// tree reads. With a `backend` only that reader is read, one read for the same answer when that reader is the one
  /// that sees what the caller is after; its failure is the op's failure (nothing else answered).
  func alertButtons(_ request: AlertRequest) async throws -> JSON {
    var options = AccessibilityRequestOptions(format: .complete, keys: wireKeys)
    options.filter = .all
    let readOptions = options
    let screen = self.screen
    return try await Session.answerAlert(request, screen: screen) { backend in
      guard let reader = backend == .ax ? self.axHostReader : self.axBridgeReader else { return nil }
      return try await reader.describe(.frontmost, options: readOptions).document
    }
  }

  /// The decision behind `alertButtons`, over a reader function (`nil` = that reader does not exist) so a scripted
  /// sequence can test it.
  static func answerAlert(
    _ request: AlertRequest, screen: (width: Double, height: Double, scale: Double),
    read: (AXBackend) async throws -> AccessibilityDocument?
  ) async throws -> JSON {
    let backends: [AXBackend] = request.backend.map { [$0] } ?? [.ax, .axbridge]
    var lastError: (any Error)?
    var answered = false
    for backend in backends {
      do {
        guard let document = try await read(backend) else { continue }
        answered = true
        if let alert = renderAlert(document: document, backend: backend, screen: screen) { return alert }
      } catch {
        lastError = error
      }
    }
    // Only a total failure is an error; one reader answering "no alert" is an answer.
    if !answered {
      if let lastError { throw lastError }
      if let backend = request.backend { throw WireError(.axUnavailable, "the \(backend.rawValue) reader is unavailable") }
    }
    return .null
  }

  /// The `alertButtons` payload for one read, or nil when that read shows no alert.
  static func renderAlert(
    document: AccessibilityDocument, backend: AXBackend, screen: (width: Double, height: Double, scale: Double)
  ) -> JSON? {
    let built = ElementBuilder.build(
      document.elements, options: buildOptions(screen: screen, document: document.screen))
    let alert =
      topmostModal(in: built.elements, modalType: document.modal?.elementType)
      ?? (backend == .ax ? hostAlertRoot(in: built.elements) : nil)
    return alert.map(alertJSON)
  }

  static func alertJSON(_ alert: Element) -> JSON {
    let descendants = alert.preorder.dropFirst()
    let buttons = descendants.filter { $0.role == .button }
    let texts = descendants.filter { $0.role == .text }.compactMap { $0.text ?? $0.label }
    var fields: [String: JSON] = ["buttons": .array(buttons.map { button in
      var leaf = button
      leaf.children = []
      return leaf.json
    })]
    if let title = texts.first ?? alert.label { fields["title"] = .string(title) }
    if texts.count > 1 { fields["message"] = .string(texts[1]) }
    return .object(fields)
  }
}

// MARK: - frontmost

/// `frontmost{bundleId}`.
struct FrontmostRequest: Sendable, Equatable {
  var bundleId: String

  init(_ params: JSON) throws {
    guard let id = params["bundleId"]?.stringValue, !id.isEmpty else {
      throw WireError(.badRequest, "frontmost needs a non-empty \"bundleId\"")
    }
    bundleId = id
  }
}

extension Session {
  /// Whether `bundleId`'s process is the one the quiescence stream reports as frontmost: the helper's own state plus one
  /// launchd lookup, no tree read and no waiting (what `settle{bundleId}` decides, without its wait, its quiet judgement
  /// or its stream restarts). A stream that has reported nothing yet answers `frontmost: false`: the stream is opened here
  /// when it is not open, so the next call knows. Needs the bridge, like `settle`.
  func frontmost(_ request: FrontmostRequest) async throws -> JSON {
    guard axDefault == "axbridge", axBridgeReader != nil else {
      throw WireError(.unsupported, "frontmost needs the axbridge backend (ax: \(axDefault), bridge: \(bridge.name))")
    }
    let monitor = try quiescenceMonitor()
    await monitor.start()
    let target: pid_t? = try? await simulator.application.processID(forBundleID: request.bundleId)
    let front = await monitor.currentFrontmostPid()
    return Session.frontmostReply(target: target, frontmost: front)
  }

  static func frontmostReply(target: pid_t?, frontmost: pid_t?) -> JSON {
    var reply: [String: JSON] = ["frontmost": .bool(target != nil && target == frontmost)]
    if let target { reply["pid"] = .int(Int(target)) }
    if let frontmost { reply["frontmostPid"] = .int(Int(frontmost)) }
    return .object(reply)
  }
}
