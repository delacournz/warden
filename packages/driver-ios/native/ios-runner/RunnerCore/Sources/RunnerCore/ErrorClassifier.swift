import Foundation

/// XCUITest does not throw for most failed interactions: it records an issue and (with `continueAfterFailure = true`)
/// carries on. The runner collects the issues an op recorded and turns them into one wire error here, so a failed
/// `typeText` is `E_NO_ELEMENT`, not a dead runner.
enum ErrorClassifier {
  static let inputOps: Set<String> = ["tap", "longPress", "swipe", "drag", "typeText", "key", "pressButton"]

  static func classify(op: String, messages: [String]) -> WireError {
    let text = messages.joined(separator: "; ")
    let lower = text.lowercased()
    let detail: JSON = ["issues": .array(messages.map(JSON.string))]
    if lower.contains("keyboard focus") || lower.contains("no matches found") || lower.contains("does not exist")
      || lower.contains("failed to find")
    {
      return WireError(.noElement, "\(op): \(text)", detail: detail)
    }
    if lower.contains("timed out") || lower.contains("unable to monitor event loop") || lower.contains("not idle") {
      return WireError(.appNotResponding, "\(op): \(text)", detail: detail)
    }
    if lower.contains("terminated") || lower.contains("not running") || lower.contains("crash")
      || lower.contains("failed to get snapshot") || lower.contains("lost connection")
    {
      return WireError(.appUnavailable, "\(op): \(text)", detail: detail)
    }
    return WireError(inputOps.contains(op) ? .hid : .internal, "\(op): \(text)", detail: detail)
  }

  /// A thrown Swift error from a snapshot or app read.
  static func classify(op: String, error: any Error) -> WireError {
    if let wire = error as? WireError { return wire }
    return classify(op: op, messages: [String(describing: error)])
  }
}
