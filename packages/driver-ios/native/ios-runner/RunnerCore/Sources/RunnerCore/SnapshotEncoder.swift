import Foundation

/// `RawNode` tree -> the `snapshot` / `alertButtons` payloads. Same shape as `warden-simd` (`Element.json`), so the TS
/// driver validates both with `snapshotDataSchema`.
enum SnapshotEncoder {
  struct Options: Equatable, Sendable {
    var interactiveOnly = false
    var maxDepth: Int?
    var maxNodes: Int?
  }

  struct Output: Equatable, Sendable {
    var elements: [Element]
    var truncated: Bool
    /// Nodes before `interactiveOnly` / limits.
    var nodes: Int
  }

  /// `space` converts every frame to portrait-up points; `screen` normalises them.
  static func build(root: RawNode, space: FrameSpace, options: Options = Options()) -> Output {
    let element = convert(root, path: "0", depth: 0, space: space)
    let nodes = element.preorder.count
    var elements = [element]
    if options.interactiveOnly { elements = elements.compactMap(pruneToInteractive) }
    var truncated = false
    if options.maxDepth != nil || options.maxNodes != nil {
      var budget = options.maxNodes ?? Int.max
      elements = limit(elements, maxDepth: options.maxDepth ?? Int.max, budget: &budget, truncated: &truncated)
    }
    return Output(elements: elements, truncated: truncated, nodes: nodes)
  }

  /// `snapshot` data. `ms` is the XCUITest read time; `fallback` says the caller asked for `axbridge`.
  static func snapshotData(
    _ output: Output, screen: RunnerInfo.Screen, ms: Double, fallback: JSON? = nil
  ) -> JSON {
    var data: [String: JSON] = [
      "backend": .string(RunnerInfo.backend),
      "screen": screen.json,
      "truncated": .bool(output.truncated),
      "elements": .array(output.elements.map(\.json)),
      "ms": .double(ms),
      "nodes": .int(output.nodes),
    ]
    if let fallback { data["fallback"] = fallback }
    return .object(data)
  }

  /// `alertButtons` data from an `Alert` / `Sheet` node: `title` is the alert's own label, else its first static text;
  /// `message` is the next static text; `buttons` are its `Button` descendants (ids `0`, `1`, ...), frames portrait-up.
  static func alertData(from alert: RawNode, space: FrameSpace) -> JSON {
    let texts = alert.preorder.filter { $0.type == "StaticText" }.map(\.label).filter { !$0.isEmpty }
    let title = alert.label.isEmpty ? texts.first : alert.label
    let message = texts.first { $0 != title }
    let buttons = alert.preorder.filter { $0.type == "Button" }.enumerated().map { index, button in
      var leaf = button
      leaf.children = []
      return convert(leaf, path: String(index), depth: 0, space: space)
    }
    var data: [String: JSON] = ["buttons": .array(buttons.map(\.json))]
    if let title, !title.isEmpty { data["title"] = .string(title) }
    if let message, !message.isEmpty { data["message"] = .string(message) }
    return .object(data)
  }

  // MARK: - Node

  static func convert(_ node: RawNode, path: String, depth: Int, space: FrameSpace) -> Element {
    let frame = space.toPortrait(node.frame)
    let screenFrame = Rect(x: 0, y: 0, width: space.width, height: space.height)
    let traits = traits(for: node)
    let rawType = node.type.isEmpty ? "Other" : node.type
    let role = RoleMap.role(forType: rawType, traits: traits)
    let value = nonEmpty(node.value)
    let label = nonEmpty(node.label)
    let hittable = node.enabled && frame.intersectsScreen(width: screenFrame.width, height: screenFrame.height)
    var element = Element(
      id: path,
      role: role,
      rawType: rawType,
      label: label,
      identifier: nonEmpty(node.identifier),
      value: value,
      text: rawType == "StaticText" ? (label ?? value) : nil,
      placeholder: nonEmpty(node.placeholder),
      frame: frame,
      normFrame: frame.normalized(width: space.width, height: space.height),
      traits: traits,
      enabled: node.enabled,
      focused: node.hasFocus,
      hidden: nil,
      selected: node.selected,
      checked: checked(role: role, value: value),
      hittable: hittable,
      tapPoint: frame.hasArea ? frame.center : nil,
      pid: nil,
      depth: depth,
      children: []
    )
    element.children = node.children.enumerated().map { index, child in
      convert(child, path: "\(path).\(index)", depth: depth + 1, space: space)
    }
    return element
  }

  /// XCUITest has no trait list, so the wire traits are derived from the element type and state (the same
  /// lowercase kebab-case names the AX reader produces).
  static func traits(for node: RawNode) -> [String] {
    var traits: [String] = []
    switch node.type {
    case "Button", "ToolbarButton", "MenuButton", "PopUpButton", "DisclosureTriangle", "MenuItem", "RadioButton":
      traits.append("button")
    case "Key": traits.append("keyboard-key")
    case "StaticText": traits.append("static-text")
    case "Link": traits.append("link")
    case "Image", "Icon": traits.append("image")
    case "SearchField": traits.append("searchfield")
    case "Keyboard": traits.append("keyboard")
    case "TabBar": traits.append("tab-bar")
    case "Tab": traits.append("tab")
    default: break
    }
    if node.selected { traits.append("selected") }
    if !node.enabled { traits.append("not-enabled") }
    if node.hasFocus, ["TextField", "SecureTextField", "SearchField", "TextView"].contains(node.type) {
      traits.append("is-editing")
    }
    return traits
  }

  static func checked(role: Role, value: String?) -> Bool? {
    guard role == .switch || role == .checkbox, let value else { return nil }
    switch value.lowercased() {
    case "1", "true", "on", "yes": return true
    case "0", "false", "off", "no": return false
    default: return nil
    }
  }

  private static func nonEmpty(_ string: String?) -> String? {
    guard let string, !string.isEmpty else { return nil }
    return string
  }

  // MARK: - Filtering (same rules as ElementBuilder in warden-simd)

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
