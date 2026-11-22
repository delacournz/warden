import Foundation

/// Reader `RawNode` tree -> normalized `Element` tree.
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
    /// Placeholders the reader left out, by field (`PlaceholderFill`); a node's own placeholder wins.
    var placeholders: [PlaceholderKey: String] = [:]
  }

  struct Output: Sendable {
    var elements: [Element]
    /// `maxDepth` / `maxNodes` cut the tree. (The backend's own truncation is added by the caller.)
    var truncated: Bool
  }

  static func build(_ nodes: [RawNode], options: Options) -> Output {
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

  // MARK: - Node

  static func convert(_ node: RawNode, path: String, depth: Int, options: Options) -> Element {
    let traits = TraitNames.normalize(node.traits ?? [])
    let rawType = nonEmpty(node.type) ?? nonEmpty(roleName(node)) ?? "Other"
    let role = RoleMap.role(forType: rawType, traits: traits)
    let label = nonEmpty(node.label)
    let value = valueString(node.value)
    let frame = rect(node.frame)
    let hidden = node.hidden
    let enabled = (node.enabled ?? true) && !traits.contains("not-enabled")
    let interactable = node.interactable

    var hittable: Bool
    var tapPoint: Point? = frame.hasArea ? frame.center : nil
    switch interactable {
    case let .actionable(x, y):
      hittable = true
      tapPoint = Point(x: x, y: y)
    case .blocked:
      hittable = false
    case nil:
      hittable =
        enabled && hidden != true && frame.intersectsScreen(width: options.screenWidth, height: options.screenHeight)
    }

    let isStaticText = rawType == "StaticText"
    var element = Element(
      id: path,
      role: role,
      rawType: rawType,
      label: label,
      identifier: nonEmpty(node.identifier),
      value: value,
      text: isStaticText ? (label ?? value) : nil,
      placeholder: nonEmpty(node.placeholder)
        ?? (options.placeholders.isEmpty ? nil : options.placeholders[PlaceholderKey(node)]),
      frame: frame,
      normFrame: frame.normalized(width: options.screenWidth, height: options.screenHeight),
      traits: traits,
      enabled: enabled,
      // UIKit leaves AX `focused` false on the first responder text field; `is-editing` is its keyboard focus
      focused: traits.contains("is-editing") ? true : node.focused,
      hidden: hidden,
      selected: node.traitsReported ? traits.contains("selected") : nil,
      checked: checked(role: role, value: value),
      hittable: hittable,
      tapPoint: tapPoint,
      pid: node.pid.map { Int($0) },
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

  static func valueString(_ value: RawValue?) -> String? {
    switch value {
    case let .string(text): return nonEmpty(text)
    case let .bool(flag): return flag ? "1" : "0"
    case let .int(number): return String(number)
    case let .double(number): return number.isFinite ? String(format: "%g", number) : nil
    default: return nil
    }
  }

  static func rect(_ frame: RawFrame?) -> Rect {
    guard let frame else { return .zero }
    return Rect(x: frame.x ?? 0, y: frame.y ?? 0, width: frame.width ?? 0, height: frame.height ?? 0)
  }

  private static func roleName(_ node: RawNode) -> String? {
    guard let raw = node.role else { return nil }
    return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
  }

  static func nonEmpty(_ string: String?) -> String? {
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
