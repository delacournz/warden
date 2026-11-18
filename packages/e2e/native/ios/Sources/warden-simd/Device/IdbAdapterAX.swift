import CoreGraphics
import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import Foundation

/// idb's `UIAutomation` (the in-guest bridge or the host translator) behind `AXReader`: its documents become
/// `RawDocument`s, its quiescence events `AXQuiescenceEvent`s, its errors `GuestError`s.
struct IdbAXReader: AXReader {
  let reader: any UIAutomation

  func describe(_ target: AXTarget, options: AXReadOptions) async throws -> RawDocument {
    let query = Self.query(target)
    let request = Self.request(options)
    return try await IdbErrors.mapping {
      Self.document(try await reader.describe(query, options: request).document)
    }
  }

  func hitTest(at point: CGPoint, options: AXReadOptions) async throws -> RawHit? {
    let request = Self.request(options)
    return try await IdbErrors.mapping {
      guard let response = try await reader.hitTest(at: point, options: request) else { return nil }
      return RawHit(
        node: response.elements.elements.first.map { Self.node($0.reportingChildren()) },
        screen: response.screen.map { RawScreen(width: $0.width, height: $0.height) })
    }
  }

  func quiescence(quietWindow: Double) async throws -> AsyncThrowingStream<AXQuiescenceEvent, any Error> {
    let events = try await IdbErrors.mapping {
      try await reader.quiescence(.frontmost, parameters: QuiescenceParameters(quietWindow: quietWindow))
    }
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for try await event in events {
            if let mapped = Self.event(event) { continuation.yield(mapped) }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: IdbErrors.map(error))
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  func readFrame() async throws -> Data {
    var options = AccessibilityRequestOptions(format: .complete, keys: [])
    options.filter = .all
    let request = options
    return try await IdbErrors.mapping {
      let document = try await reader.describe(.frontmost, options: request).document
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      return try encoder.encode(document)
    }
  }

  // MARK: - Requests

  static func query(_ target: AXTarget) -> AccessibilityElementQuery {
    switch target {
    case .frontmost: return .frontmost
    case let .application(pid): return .application(pid: pid)
    }
  }

  static func request(_ options: AXReadOptions) -> AccessibilityRequestOptions {
    guard let keys = options.keys else { return AccessibilityRequestOptions() }
    var request = AccessibilityRequestOptions(format: .complete, keys: Set(keys.map { $0.idb }))
    request.filter = .all
    return request
  }

  // MARK: - Documents

  static func document(_ document: AccessibilityDocument) -> RawDocument {
    RawDocument(
      elements: document.elements.map(node),
      modal: document.modal.map { RawModal(elementType: $0.elementType, label: $0.label) },
      truncated: document.truncated,
      screen: document.screen.map { RawScreen(width: $0.width, height: $0.height) },
      rawJSON: {
        guard let encoded = try? JSONEncoder().encode(document) else { return nil }
        return try? JSONDecoder().decode(JSON.self, from: encoded)
      })
  }

  /// idb's document attributes are doubly optional (unset vs. explicit null); both mean "unknown" here, except that a
  /// reported `traits` field (even null) is remembered.
  static func node(_ node: AccessibilityDocumentElement) -> RawNode {
    func flat<T>(_ value: T??) -> T? { value ?? nil }
    var raw = RawNode(
      label: flat(node.label), identifier: flat(node.identifier), type: flat(node.type), role: flat(node.role),
      placeholder: flat(node.placeholder), value: flat(node.value).map(value),
      frame: flat(node.frame).map { RawFrame(x: $0.x, y: $0.y, width: $0.width, height: $0.height) },
      enabled: flat(node.enabled), hidden: flat(node.hidden), focused: flat(node.focused),
      interactable: flat(node.interactable).map(interactable), traits: flat(node.traits),
      traitsReported: node.traits != nil, pid: flat(node.pid))
    raw.children = node.children?.map(Self.node)
    return raw
  }

  private static func value(_ value: AccessibilityAttributeValue) -> RawValue {
    switch value {
    case let .string(text): return .string(text)
    case let .bool(flag): return .bool(flag)
    case let .int(number): return .int(number)
    case let .double(number): return .double(number)
    default: return .unsupported
    }
  }

  private static func interactable(_ value: AccessibilityInteractable) -> RawInteractable {
    switch value {
    case let .actionable(point): return .actionable(x: point.x, y: point.y)
    case .blocked: return .blocked
    @unknown default: return .blocked
    }
  }

  // MARK: - Quiescence

  static func event(_ event: QuiescenceEvent) -> AXQuiescenceEvent? {
    switch event {
    case let .state(state, pid): return .state(self.state(state), pid: pid)
    case let .touchesCompleted(pid): return .touchesCompleted(pid: pid)
    case let .targetChanged(pid): return .targetChanged(pid: pid)
    case let .targetExited(pid): return .targetExited(pid: pid)
    @unknown default: return nil
    }
  }

  static func signal(_ signal: QuiescenceSignal) -> AXQuiescenceSignal? {
    switch signal {
    case .runLoopIdle: return .runLoopIdle
    case .animationsInactive: return .animationsInactive
    @unknown default: return nil
    }
  }

  static func state(_ state: QuiescenceState) -> AXQuiescenceState {
    switch state {
    case let .busy(signals): return .busy(Set(signals.compactMap(signal)))
    case .settling: return .settling
    case .quiet: return .quiet
    @unknown default: return .settling
    }
  }
}

extension AXKey {
  /// The keys idb accepts as names (`AXKeys.requested`), as warden keys.
  static func requested(_ names: [String]) -> Set<AXKey> {
    Set(AXKeys.requested(names).compactMap(AXKey.init))
  }

  /// idb spells its keys differently on the wire (`AXLabel`, `custom_actions`, ...), so the two enums are mapped by case.
  init?(_ key: AXKeys) {
    switch key {
    case .label: self = .label
    case .frame: self = .frame
    case .value: self = .value
    case .uniqueID: self = .uniqueID
    case .type: self = .type
    case .title: self = .title
    case .frameDict: self = .frameDict
    case .help: self = .help
    case .enabled: self = .enabled
    case .customActions: self = .customActions
    case .role: self = .role
    case .roleDescription: self = .roleDescription
    case .subrole: self = .subrole
    case .contentRequired: self = .contentRequired
    case .pid: self = .pid
    case .traits: self = .traits
    case .expanded: self = .expanded
    case .placeholder: self = .placeholder
    case .hidden: self = .hidden
    case .focused: self = .focused
    case .isRemote: self = .isRemote
    case .interactable: self = .interactable
    case .occludedBy: self = .occludedBy
    @unknown default: return nil
    }
  }

  var idb: AXKeys {
    switch self {
    case .label: return .label
    case .frame: return .frame
    case .value: return .value
    case .uniqueID: return .uniqueID
    case .type: return .type
    case .title: return .title
    case .frameDict: return .frameDict
    case .help: return .help
    case .enabled: return .enabled
    case .customActions: return .customActions
    case .role: return .role
    case .roleDescription: return .roleDescription
    case .subrole: return .subrole
    case .contentRequired: return .contentRequired
    case .pid: return .pid
    case .traits: return .traits
    case .expanded: return .expanded
    case .placeholder: return .placeholder
    case .hidden: return .hidden
    case .focused: return .focused
    case .isRemote: return .isRemote
    case .interactable: return .interactable
    case .occludedBy: return .occludedBy
    }
  }
}

extension FrontmostMethod {
  var idb: AXBridgeFrontmostMethod {
    switch self {
    case .centerPoint: return .centerPoint
    case .windowServer: return .windowServer
    case .runningBoard: return .runningBoard
    }
  }
}
