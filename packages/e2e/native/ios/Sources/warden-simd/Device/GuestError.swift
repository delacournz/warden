import Foundation

/// What went wrong on the simulator side of a call, in warden's terms. Backend adapters map their own errors onto this
/// once (`IdbErrors.map`); ops, the fallback and stall policy and the wire mapping only ever see these. Each case keeps
/// the backend's own message, which is what reaches the wire and the logs.
enum GuestError: Error, LocalizedError, Sendable, Equatable {
  /// The app a read was addressed to is gone.
  case appUnavailable(pid: pid_t?, bundleID: String?, message: String)
  /// The app is there but answered nothing in time.
  case appNotResponding(pid: pid_t?, bundleID: String?, message: String)
  /// The in-sim guest did not answer within `afterSeconds`.
  case guestNotAnswering(afterSeconds: Double, message: String)
  /// The guest could not come up or be reached; the host reader may still answer.
  case bridgeUnavailable(message: String)
  /// The guest could not name the frontmost app.
  case frontmostUnresolved(message: String)
  /// An accessibility service is down and no other reader is named for it (`E_AX_UNAVAILABLE`).
  case axUnavailable(message: String)
  /// The host reader's service did not answer a request in time. `frontmost`: the request was the frontmost lookup.
  case hostSilent(request: String?, elapsedMs: Int, behindAbandoned: Int, frontmost: Bool, message: String)
  /// The host reader has no service to ask. `frontmostMissing`: it named no frontmost application. `serviceAnswered`:
  /// the accessibility server itself answered (it had nothing to translate the query to), as opposed to there being
  /// no server to ask (SpringBoard down or restarting, accessibility or the dispatcher unavailable).
  case hostUnavailable(frontmostMissing: Bool, serviceAnswered: Bool = false, message: String)
  case hostNotBooted(message: String)
  case hostNoElement(message: String)
  /// Any other host reader failure.
  case hostFailure(message: String)
  /// Nothing under the point.
  case noElementAtPoint(message: String)
  /// Nothing matched; `retryable` when the element moved and a second look may find it.
  case noElement(message: String, retryable: Bool)
  case timeout(message: String)
  case invalidRequest(message: String)
  case unsupported(message: String)
  /// The process the stream was bound to exited.
  case targetExited(pid: pid_t, message: String)
  /// The app is not installed (or has no data container).
  case appNotInstalled(bundleID: String, message: String)
  case appAlreadyRunning(bundleID: String, pid: pid_t, message: String)
  /// launchd has no process for the bundle: nothing is running.
  case noRunningProcess(message: String)
  /// A read during a rotation: the display settles within the animation, so the caller looks again.
  case displayChanging(message: String)
  case hid(message: String)
  case io(message: String)
  case failed(message: String)

  var message: String {
    switch self {
    case let .appUnavailable(_, _, message), let .appNotResponding(_, _, message), let .guestNotAnswering(_, message),
      let .bridgeUnavailable(message), let .frontmostUnresolved(message), let .axUnavailable(message),
      let .hostSilent(_, _, _, _, message), let .hostUnavailable(_, _, message), let .hostNotBooted(message),
      let .hostNoElement(message), let .hostFailure(message), let .noElementAtPoint(message),
      let .noElement(message, _), let .timeout(message), let .invalidRequest(message), let .unsupported(message),
      let .targetExited(_, message), let .appNotInstalled(_, message), let .appAlreadyRunning(_, _, message),
      let .noRunningProcess(message), let .displayChanging(message), let .hid(message), let .io(message),
      let .failed(message):
      return message
    }
  }

  var errorDescription: String? { message }

  // MARK: - Classification

  /// "The in-guest bridge cannot answer right now", where the host `ax` reader still may.
  var isBridgeFailure: Bool {
    switch self {
    case .bridgeUnavailable, .frontmostUnresolved, .appUnavailable, .appNotResponding, .guestNotAnswering:
      return true
    default:
      return false
    }
  }

  /// The app answered nothing in time (as opposed to being gone).
  var isNotResponding: Bool {
    if case .appNotResponding = self { return true }
    return false
  }

  /// The pid of the process that did not respond, when the error names one.
  var notRespondingPid: pid_t? {
    if case let .appNotResponding(pid, _, _) = self { return pid }
    return nil
  }

  /// The read failed because the frontmost app could not be resolved, not because the app or the guest is gone.
  var isFrontmostUnresolved: Bool {
    switch self {
    case .frontmostUnresolved: return true
    case let .hostSilent(_, _, _, frontmost, _): return frontmost
    case let .hostUnavailable(frontmostMissing, _, _): return frontmostMissing
    default: return false
    }
  }

  var isGuestSilent: Bool {
    if case .guestNotAnswering = self { return true }
    return false
  }

  var isHostSilent: Bool {
    if case .hostSilent = self { return true }
    return false
  }

  /// The host reader's service answered, with an error (e.g. no translation object): not silence, and not a failure
  /// to ask (SpringBoard down or restarting, accessibility or the dispatcher unavailable, the sim not booted).
  var isHostServiceAnswer: Bool {
    switch self {
    case .hostNoElement, .hostFailure: return true
    case let .hostUnavailable(_, serviceAnswered, _): return serviceAnswered
    default: return false
    }
  }

  // MARK: - Wire

  /// The wire error: the codes, retryability and detail fields clients read.
  var wire: WireError {
    let message = self.message
    switch self {
    case let .appUnavailable(pid, bundleID, _):
      return WireError(.appUnavailable, message, detail: Self.appDetail(pid: pid, bundleID: bundleID))
    case let .appNotResponding(pid, bundleID, _):
      return WireError(.appNotResponding, message, detail: Self.appDetail(pid: pid, bundleID: bundleID))
    case let .guestNotAnswering(after, _):
      return WireError(.timeout, message, detail: .object(["afterSeconds": .double(after)]))
    case .bridgeUnavailable, .frontmostUnresolved, .axUnavailable:
      return WireError(.axUnavailable, message)
    case let .hostSilent(request, elapsedMs, behindAbandoned, _, _):
      var fields = hostFields(message)
      if let request { fields["request"] = .string(request) }
      fields["elapsedMs"] = .int(elapsedMs)
      if behindAbandoned > 0 { fields["behindAbandoned"] = .int(behindAbandoned) }
      return WireError(.timeout, message, detail: .object(fields))
    case .hostUnavailable:
      return WireError(.axUnavailable, message, detail: .object(hostFields(message)))
    case .hostNotBooted:
      return WireError(.notBooted, message)
    case .hostNoElement, .noElementAtPoint:
      return WireError(.noElement, message)
    case .hostFailure:
      return WireError(.internal, message, detail: .object(hostFields(message)))
    case let .noElement(_, retryable):
      return retryable ? WireError(.noElement, message, retryable: true) : WireError(.noElement, message)
    case .timeout:
      return WireError(.timeout, message)
    case .invalidRequest:
      return WireError(.badRequest, message)
    case .unsupported:
      return WireError(.unsupported, message)
    case let .targetExited(pid, _):
      return WireError(.appUnavailable, message, detail: Self.appDetail(pid: pid, bundleID: nil))
    case let .appNotInstalled(bundleID, _):
      return WireError(.appUnavailable, message, detail: Self.appDetail(pid: nil, bundleID: bundleID))
    case let .appAlreadyRunning(bundleID, pid, _):
      return WireError(.internal, message, detail: Self.appDetail(pid: pid, bundleID: bundleID))
    case .noRunningProcess:
      return WireError(.appUnavailable, message)
    case .displayChanging:
      return WireError(.internal, message, retryable: true, detail: ["reason": "display_changing"])
    case .hid:
      return WireError(.hid, message, detail: ["kind": "SimulatorHIDError"])
    case .io:
      return WireError(.io, message)
    case .failed:
      return WireError(.internal, message)
    }
  }

  /// The host translator (`ax`): which stage failed and what it said; a missing frontmost app says so in
  /// `detail.reason` (`frontmost_unresolved`), which the TS driver records on the snapshot span.
  private func hostFields(_ message: String) -> [String: JSON] {
    var fields: [String: JSON] = ["stage": "ax", "axError": .string(message)]
    if isFrontmostUnresolved { fields["reason"] = "frontmost_unresolved" }
    return fields
  }

  private static func appDetail(pid: pid_t?, bundleID: String?) -> JSON? {
    var fields: [String: JSON] = [:]
    if let pid { fields["pid"] = .int(Int(pid)) }
    if let bundleID { fields["bundleId"] = .string(bundleID) }
    return fields.isEmpty ? nil : .object(fields)
  }
}

extension WireError {
  /// Maps anything an op can throw onto a wire error. Backend failures arrive as `GuestError`s (the adapters map them
  /// once, where they are thrown): AX failures are `E_AX_UNAVAILABLE` / `E_APP_*`, HID failures `E_HID`, "nothing
  /// there" `E_NO_ELEMENT`.
  static func from(_ error: any Error) -> WireError {
    if let wire = error as? WireError { return wire }
    if let both = error as? AXReadersFailed {
      let host = from(both.host)
      var fields = host.detail?.objectValue ?? [:]
      fields["bridgeError"] = .string(both.bridgeReason)
      if fields["axError"] == nil { fields["axError"] = .string(host.message) }
      if let stall = both.stall { fields["stall"] = stall.json }
      return WireError(host.code, both.localizedDescription, retryable: host.retryable, detail: .object(fields))
    }
    if let error = error as? GuestError { return error.wire }
    if let stall = error as? BridgeStalled {
      var fields: [String: JSON] = ["afterMs": .int(stall.afterMs), "stage": "axbridge"]
      if let report = stall.report { fields["stall"] = report.json }
      return WireError(.timeout, stall.localizedDescription, detail: .object(fields))
    }
    if error is CancellationError { return WireError(.internal, "operation cancelled") }
    let nsError = error as NSError
    if nsError.domain == NSCocoaErrorDomain || nsError.domain == NSPOSIXErrorDomain {
      return WireError(.io, nsError.localizedDescription)
    }
    return WireError(.internal, error.localizedDescription)
  }
}
