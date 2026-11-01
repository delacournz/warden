import FBSimulatorAX
import Foundation

/// idb `AccessibilityDocumentElement` tree -> normalized `Element` tree.
enum ElementBuilder {
  struct Options: Sendable {
    var screenWidth: Double
    var screenHeight: Double
    /// Drop everything but interactive elements, elements with an identifier, and their ancestors.
    var interactiveOnly = false
    /// Nodes at `depth >= maxDepth` are dropped (roots are depth 0).
    var maxDepth: Int?
    /// At most this many nodes (preorder, after `interactiveOnly`).
    var maxNodes: Int?
  }

  struct Output: Sendable {
    var elements: [Element]
    /// `maxDepth` / `maxNodes` cut the tree. (The backend's own truncation is added by the caller.)
    var truncated: Bool
  }

  static func build(_ nodes: [AccessibilityDocumentElement], options: Options) -> Output {
    // ids are the preorder path in the *unfiltered* tree, so `0.2.1` names the same node with or without
    // `interactiveOnly`.
    var elements = nodes.enumerated().map { index, node in
      convert(node, path: String(index), depth: 0, options: options)
    }
    if options.interactiveOnly {
      elements = elements.compactMap(pruneToInteractive)
    }
    var truncated = false
    if options.maxDepth != nil || options.maxNodes != nil {
      var budget = options.maxNodes ?? Int.max
      elements = limit(elements, maxDepth: options.maxDepth ?? Int.max, budget: &budget, truncated: &truncated)
    }
    return Output(elements: elements, truncated: truncated)
  }

  /// idb's document attributes are doubly optional (unset vs. explicit null); both mean "unknown" here.
  static func flat<T>(_ value: T??) -> T? { value ?? nil }

  // MARK: - Node

  static func convert(_ node: AccessibilityDocumentElement, path: String, depth: Int, options: Options) -> Element {
    let traits = TraitNames.normalize(flat(node.traits) ?? [])
    let rawType = nonEmpty(flat(node.type)) ?? nonEmpty(roleName(node)) ?? "Other"
    let role = RoleMap.role(forType: rawType, traits: traits)
    let label = nonEmpty(flat(node.label))
    let value = valueString(flat(node.value))
    let frame = rect(flat(node.frame))
    let hidden = flat(node.hidden)
    let enabled = (flat(node.enabled) ?? true) && !traits.contains("not-enabled")
    let interactable = flat(node.interactable)

    var hittable: Bool
    var tapPoint: Point? = frame.hasArea ? frame.center : nil
    switch interactable {
    case let .actionable(point):
      hittable = true
      tapPoint = Point(x: point.x, y: point.y)
    case .blocked:
      hittable = false
    case nil:
      hittable =
        enabled && hidden != true && frame.intersectsScreen(width: options.screenWidth, height: options.screenHeight)
    @unknown default:
      hittable = false
    }

    let isStaticText = rawType == "StaticText"
    var element = Element(
      id: path,
      role: role,
      rawType: rawType,
      label: label,
      identifier: nonEmpty(flat(node.identifier)),
      value: value,
      text: isStaticText ? (label ?? value) : nil,
      placeholder: nonEmpty(flat(node.placeholder)),
      frame: frame,
      normFrame: frame.normalized(width: options.screenWidth, height: options.screenHeight),
      traits: traits,
      enabled: enabled,
      // UIKit leaves AX `focused` false on the first responder text field; `is-editing` is its keyboard focus
      focused: traits.contains("is-editing") ? true : flat(node.focused),
      hidden: hidden,
      selected: node.traits == nil ? nil : traits.contains("selected"),
      checked: checked(role: role, value: value),
      hittable: hittable,
      tapPoint: tapPoint,
      pid: flat(node.pid).map { Int($0) },
      depth: depth,
      children: []
    )
    element.children = (node.children ?? []).enumerated().map { index, child in
      convert(child, path: "\(path).\(index)", depth: depth + 1, options: options)
    }
    return element
  }

  /// A switch / checkbox value is `"1"` / `"0"` on iOS.
  static func checked(role: Role, value: String?) -> Bool? {
    guard role == .switch || role == .checkbox, let value else { return nil }
    switch value.lowercased() {
    case "1", "true", "on", "yes": return true
    case "0", "false", "off", "no": return false
    default: return nil
    }
  }

  static func valueString(_ value: AccessibilityAttributeValue?) -> String? {
    switch value {
    case let .string(text): return nonEmpty(text)
    case let .bool(flag): return flag ? "1" : "0"
    case let .int(number): return String(number)
    case let .double(number): return number.isFinite ? String(format: "%g", number) : nil
    default: return nil
    }
  }

  static func rect(_ frame: AccessibilityFrame?) -> Rect {
    guard let frame else { return .zero }
    return Rect(x: frame.x ?? 0, y: frame.y ?? 0, width: frame.width ?? 0, height: frame.height ?? 0)
  }

  private static func roleName(_ node: AccessibilityDocumentElement) -> String? {
    guard let raw = flat(node.role) else { return nil }
    return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
  }

  private static func nonEmpty(_ string: String?) -> String? {
    guard let string, !string.isEmpty else { return nil }
    return string
  }

  // MARK: - Filtering

  private static func pruneToInteractive(_ element: Element) -> Element? {
    let kept = element.children.compactMap(pruneToInteractive)
    guard element.isInteractive || element.identifier != nil || !kept.isEmpty else { return nil }
    var copy = element
    copy.children = kept
    return copy
  }

  private static func limit(
    _ elements: [Element], maxDepth: Int, budget: inout Int, truncated: inout Bool
  ) -> [Element] {
    var result: [Element] = []
    for element in elements {
      guard element.depth < maxDepth, budget > 0 else {
        truncated = true
        continue
      }
      budget -= 1
      var copy = element
      copy.children = limit(element.children, maxDepth: maxDepth, budget: &budget, truncated: &truncated)
      result.append(copy)
    }
    return result
  }
}
