import CoreGraphics
import Foundation

// warden's own view of what an accessibility reader returns: a tree of `RawNode`s, before `ElementBuilder` turns it
// into the wire `Element`. A backend adapter fills these in; nothing else knows how the backend spells them.

struct RawFrame: Sendable, Equatable {
  var x: Double?
  var y: Double?
  var width: Double?
  var height: Double?

  /// A non-finite edge reads as absent (a reader that cannot tell where an element is says so with NaN or infinity).
  init(x: Double?, y: Double?, width: Double?, height: Double?) {
    func finite(_ value: Double?) -> Double? { value.flatMap { $0.isFinite ? $0 : nil } }
    self.x = finite(x)
    self.y = finite(y)
    self.width = finite(width)
    self.height = finite(height)
  }
}

/// A node's `value`: the scalar kinds the wire shows; arrays, objects and null read as no value.
enum RawValue: Sendable, Equatable {
  case string(String)
  case bool(Bool)
  case int(Int64)
  case double(Double)
  case unsupported
}

enum RawInteractable: Sendable, Equatable {
  case actionable(x: Double, y: Double)
  case blocked
}

struct RawNode: Sendable, Equatable {
  var label: String?
  var identifier: String?
  var type: String?
  var role: String?
  var placeholder: String?
  var value: RawValue?
  var frame: RawFrame?
  var enabled: Bool?
  var hidden: Bool?
  var focused: Bool?
  var interactable: RawInteractable?
  var traits: [String]? {
    didSet { if traits != nil { traitsReported = true } }
  }
  /// The reader reported a `traits` field at all (even an empty or null one): a node without it has no `selected`.
  var traitsReported = false
  var pid: Int64?
  var children: [RawNode]?

  init(
    label: String? = nil, identifier: String? = nil, type: String? = nil, role: String? = nil,
    placeholder: String? = nil, value: RawValue? = nil, frame: RawFrame? = nil, enabled: Bool? = nil,
    hidden: Bool? = nil, focused: Bool? = nil, interactable: RawInteractable? = nil, traits: [String]? = nil,
    traitsReported: Bool = false, pid: Int64? = nil, children: [RawNode]? = nil
  ) {
    self.label = label
    self.identifier = identifier
    self.type = type
    self.role = role
    self.placeholder = placeholder
    self.value = value
    self.frame = frame
    self.enabled = enabled
    self.hidden = hidden
    self.focused = focused
    self.interactable = interactable
    self.traits = traits
    self.traitsReported = traitsReported || traits != nil
    self.pid = pid
    self.children = children
  }
}

extension Array where Element == RawNode {
  /// Every node in the forest, children included.
  var nodeCount: Int { reduce(0) { $0 + 1 + ($1.children ?? []).nodeCount } }
}

/// The blocking modal the reader named (an alert or a sheet), when it has one.
struct RawModal: Sendable, Equatable {
  var elementType: String
  var label: String?
}

struct RawScreen: Sendable, Equatable {
  var width: Double
  var height: Double
}

struct RawDocument: Sendable {
  var elements: [RawNode]
  var modal: RawModal?
  var truncated: Bool
  var screen: RawScreen?
  /// The reader's own serialization of the tree, for `snapshot{raw:true}` (fixture capture). Nil for a hand-built one.
  var rawJSON: (@Sendable () -> JSON?)?

  init(
    elements: [RawNode], modal: RawModal? = nil, truncated: Bool = false, screen: RawScreen? = nil,
    rawJSON: (@Sendable () -> JSON?)? = nil
  ) {
    self.elements = elements
    self.modal = modal
    self.truncated = truncated
    self.screen = screen
    self.rawJSON = rawJSON
  }
}

/// What a hit-test answers: the one node under the point (children summarised away) and the screen it was read on.
struct RawHit: Sendable {
  var node: RawNode?
  var screen: RawScreen?
}

/// The attribute keys a read asks for (the names the reader accepts on its command line).
enum AXKey: String, Sendable, CaseIterable, Hashable {
  case label
  case frame
  case value
  case uniqueID
  case type
  case title
  case frameDict
  case help
  case enabled
  case customActions
  case role
  case roleDescription
  case subrole
  case contentRequired
  case pid
  case traits
  case expanded
  case placeholder
  case hidden
  case focused
  case isRemote
  case interactable
  case occludedBy
}

/// Exactly the keys the TS `Element` is built from. The reader's default set also fetches title / help / role
/// description / subrole / custom actions / content-required, each an extra attribute read per node that nothing here
/// uses.
let wireKeys: Set<AXKey> = [
  .label, .value, .uniqueID, .type, .frameDict, .enabled, .pid, .traits, .placeholder, .hidden, .focused,
]

/// How one read is asked. `keys` nil = the reader's defaults; otherwise the complete format with every element kept
/// and exactly these keys.
struct AXReadOptions: Sendable, Equatable {
  var keys: Set<AXKey>?

  static let readerDefaults = AXReadOptions(keys: nil)

  static func complete(keys: Set<AXKey>) -> AXReadOptions { AXReadOptions(keys: keys) }
}

enum AXTarget: Sendable, Equatable {
  case frontmost
  case application(pid: pid_t)
}

// MARK: - Quiescence

enum AXQuiescenceSignal: String, Sendable, Hashable, CaseIterable {
  case runLoopIdle = "run_loop_idle"
  case animationsInactive = "animations_inactive"
}

enum AXQuiescenceState: Sendable, Equatable {
  case busy(Set<AXQuiescenceSignal>)
  case settling
  case quiet
}

enum AXQuiescenceEvent: Sendable, Equatable {
  case state(AXQuiescenceState, pid: pid_t)
  case touchesCompleted(pid: pid_t)
  case targetChanged(pid: pid_t)
  case targetExited(pid: pid_t)
}

// MARK: - Reader

/// One accessibility reader: the in-guest bridge or the host translator. Errors are `GuestError`s.
protocol AXReader: Sendable {
  func describe(_ target: AXTarget, options: AXReadOptions) async throws -> RawDocument
  /// The element at a point; nil when the reader answers nothing for it. Throws `GuestError.noElementAtPoint` when the
  /// reader says there is none.
  func hitTest(at point: CGPoint, options: AXReadOptions) async throws -> RawHit?
  /// A stream of quiescence events for the frontmost app (`quietWindow` seconds of calm count as quiet).
  func quiescence(quietWindow: Double) async throws -> AsyncThrowingStream<AXQuiescenceEvent, any Error>
  /// One cheap tree read of the frontmost app, encoded with sorted keys: two equal frames mean the screen held still.
  func readFrame() async throws -> Data
}
