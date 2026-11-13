import FBSimulatorAX
import Foundation

/// One text field as the bridge reports it: enough to find it again in the next read and in a host hit-test answer.
struct PlaceholderKey: Hashable, Sendable {
  var pid: Int64?
  var identifier: String?
  var label: String?
  var x: Int
  var y: Int
  var width: Int
  var height: Int

  init(pid: Int64?, identifier: String?, label: String?, x: Int, y: Int, width: Int, height: Int) {
    self.pid = pid
    self.identifier = identifier
    self.label = label
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  init(_ node: AccessibilityDocumentElement) {
    let frame = ElementBuilder.rect(ElementBuilder.flat(node.frame))
    self.init(
      pid: ElementBuilder.flat(node.pid), identifier: ElementBuilder.nonEmpty(ElementBuilder.flat(node.identifier)),
      label: ElementBuilder.nonEmpty(ElementBuilder.flat(node.label)), x: Int(frame.x.rounded()),
      y: Int(frame.y.rounded()), width: Int(frame.width.rounded()), height: Int(frame.height.rounded()))
  }

  /// Whether a host hit-test answer is this field: same testID and frame (label and pid are the bridge's view).
  func sameField(as other: PlaceholderKey) -> Bool {
    identifier == other.identifier && x == other.x && y == other.y && width == other.width && height == other.height
  }
}

/// What the helper learned about each text field's placeholder, for the life of the process.
final class PlaceholderMemory: @unchecked Sendable {
  enum Lookup: Equatable, Sendable {
    case unknown
    case none
    case placeholder(String)
  }

  /// A screen with this many fields remembered is starting over (a long session across many screens).
  static let capacity = 512

  private let lock = NSLock()
  private var known: [PlaceholderKey: String?] = [:]
  private var pausedUntil: TimeInterval = 0

  func lookup(_ key: PlaceholderKey) -> Lookup {
    lock.withLock {
      guard let entry = known[key] else { return .unknown }
      return entry.map(Lookup.placeholder) ?? .none
    }
  }

  func remember(_ key: PlaceholderKey, placeholder: String?) {
    lock.withLock {
      if known.count >= Self.capacity { known.removeAll() }
      known[key] = .some(placeholder)
    }
  }

  func paused(at now: TimeInterval) -> Bool { lock.withLock { now < pausedUntil } }
  func pause(until time: TimeInterval) { lock.withLock { pausedUntil = time } }
}

/// The bridge reader (XCTest's snapshot attributes) leaves `placeholder` empty on React Native text inputs, while
/// iOS still reports the placeholder as the `value` of an empty field: `value="ada@example.com"` on an empty email
/// field reads as filled. The host `ax` reader names the placeholder, so each such field is hit-tested on the host
/// once (~10 ms) and the answer is kept by field (pid, testID, label, frame); later reads cost nothing.
enum PlaceholderFill {
  typealias HitTest = @Sendable (CGPoint) async throws -> AccessibilityDocumentElement?

  /// Hit-tests one read may spend on fields it has not seen; the rest wait for the next read.
  static let maxHitsPerRead = 6
  /// A host hit-test that takes longer than this is given up (the read goes out without that placeholder).
  static let hitDeadlineMs = 250
  /// After a failed or late hit-test no field is asked for this long (a silent host reader costs every read).
  static let backoffSeconds: TimeInterval = 30

  /// Text fields (any reader-visible text entry) that show a value and name no placeholder, with their centre.
  static func candidates(_ roots: [AccessibilityDocumentElement]) -> [(key: PlaceholderKey, point: CGPoint)] {
    var found: [(key: PlaceholderKey, point: CGPoint)] = []
    func walk(_ node: AccessibilityDocumentElement) {
      if isCandidate(node) {
        let frame = ElementBuilder.rect(ElementBuilder.flat(node.frame))
        found.append((PlaceholderKey(node), CGPoint(x: frame.center.x, y: frame.center.y)))
      }
      for child in node.children ?? [] { walk(child) }
    }
    roots.forEach(walk)
    return found
  }

  static func isCandidate(_ node: AccessibilityDocumentElement) -> Bool {
    guard ElementBuilder.nonEmpty(ElementBuilder.flat(node.placeholder)) == nil,
      ElementBuilder.valueString(ElementBuilder.flat(node.value)) != nil,
      ElementBuilder.rect(ElementBuilder.flat(node.frame)).hasArea
    else { return false }
    let traits = TraitNames.normalize(ElementBuilder.flat(node.traits) ?? [])
    let type = ElementBuilder.nonEmpty(ElementBuilder.flat(node.type)) ?? "Other"
    switch RoleMap.role(forType: type, traits: traits) {
    case .textfield, .securefield, .searchfield: return true
    default: return false
    }
  }

  /// The placeholders of `candidates`: remembered ones, then up to `maxHitsPerRead` host hit-tests for the rest. A
  /// hit that lands on another element teaches nothing; a failed one pauses all hits for `backoffSeconds`.
  static func resolve(
    _ candidates: [(key: PlaceholderKey, point: CGPoint)], memory: PlaceholderMemory, now: TimeInterval,
    hit: HitTest
  ) async -> [PlaceholderKey: String] {
    var found: [PlaceholderKey: String] = [:]
    var hits = 0
    for candidate in candidates {
      switch memory.lookup(candidate.key) {
      case let .placeholder(text):
        found[candidate.key] = text
        continue
      case .none:
        continue
      case .unknown:
        break
      }
      guard hits < maxHitsPerRead, !memory.paused(at: now) else { continue }
      hits += 1
      do {
        guard let node = try await hit(candidate.point), candidate.key.sameField(as: PlaceholderKey(node)) else {
          continue
        }
        let placeholder = ElementBuilder.nonEmpty(ElementBuilder.flat(node.placeholder))
        memory.remember(candidate.key, placeholder: placeholder)
        if let placeholder { found[candidate.key] = placeholder }
      } catch {
        memory.pause(until: now + backoffSeconds)
      }
    }
    return found
  }
}

extension Session {
  /// Placeholders the bridge left out of `document` (see `PlaceholderFill`); empty for any other reader.
  func missingPlaceholders(in document: AccessibilityDocument, backend: AXBackend) async -> [PlaceholderKey: String] {
    guard backend == .axbridge, let host = axHostReader else { return [:] }
    let candidates = PlaceholderFill.candidates(document.elements)
    guard !candidates.isEmpty else { return [:] }
    var options = AccessibilityRequestOptions(format: .complete, keys: wireKeys)
    options.filter = .all
    let readOptions = options
    let deadlineMs = PlaceholderFill.hitDeadlineMs
    return await PlaceholderFill.resolve(
      candidates, memory: placeholderMemory, now: ProcessInfo.processInfo.systemUptime
    ) { point in
      try await withTimeout(milliseconds: deadlineMs, error: { BridgeStalled(afterMs: deadlineMs) }) {
        try await host.hitTest(at: point, options: readOptions)?.elements.elements.first
      }
    }
  }
}
