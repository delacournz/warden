import Foundation

/// Runs each op on the XCUITest work queue (`.main` in the runner) under a deadline, from the transport queue, so a
/// wedged XCUITest call (an app that never idles, a hung accessibility read) cannot hang the server.
///
/// A block cannot be cancelled once it runs. An op that outlives its budget is answered `E_TIMEOUT` (`stage:
/// "deadline"`) and left running; until it returns the gate is busy: every op is answered `E_TIMEOUT` (`stage:
/// "busy"`, retryable) at once, without queueing behind it, `health` answers `state: "busy"` from the transport queue,
/// and `shutdown` is acknowledged. The client's own timeout stays longer than the budget, so the runner's verdict wins.
final class WorkGate: @unchecked Sendable {
  struct Busy: Equatable, Sendable {
    let op: String
    let id: String
    let since: Date
  }

  /// Budget for a request that carries no `timeoutMs`.
  static let defaultBudgetMs = 30_000

  private let work: DispatchQueue
  private let now: () -> Date
  private let lock = NSLock()
  /// The op running on `work` (answered or not). Cleared when its block returns.
  private var running: Busy?
  /// True once `running` outlived its budget and was answered `E_TIMEOUT`.
  private var abandoned = false

  init(work: DispatchQueue, now: @escaping () -> Date = Date.init) {
    self.work = work
    self.now = now
  }

  /// The abandoned op still holding the work queue, if any.
  var busy: Busy? {
    lock.withLock { abandoned ? running : nil }
  }

  /// `timeoutMs` minus room for the answer to reach the client (500 ms, at most half the timeout).
  static func budgetMs(requestTimeoutMs: Int?) -> Int {
    guard let timeoutMs = requestTimeoutMs else { return defaultBudgetMs }
    return max(timeoutMs / 2, timeoutMs - 500)
  }

  /// Answers `request` with `serve` run on the work queue, or a busy / deadline error. `health(state, busy)` builds the
  /// `health` data answered while busy.
  func respond(
    to request: Request, health: (_ state: String, _ busy: JSON?) -> JSON,
    serve: @escaping @Sendable (Request) -> Response
  ) -> Response {
    if let busy {
      return answerWhileBusy(request, busy: busy, health: health)
    }
    let started = now()
    lock.withLock { running = Busy(op: request.op, id: request.id, since: started) }
    let done = DispatchSemaphore(value: 0)
    let box = ResponseBox()
    work.async { [weak self] in
      box.value = serve(request)
      if let self { self.lock.withLock { self.running = nil; self.abandoned = false } }
      done.signal()
    }
    let budget = Self.budgetMs(requestTimeoutMs: request.timeoutMs)
    if done.wait(timeout: .now() + .milliseconds(budget)) == .success, let response = box.value {
      return response
    }
    // Lost the race only if the block finished between the timeout and taking the lock.
    let stillRunning = lock.withLock { () -> Bool in
      guard running != nil else { return false }
      abandoned = true
      return true
    }
    if !stillRunning {
      done.wait()
      if let response = box.value { return response }
    }
    return .failure(
      id: request.id,
      error: WireError(
        .timeout,
        "\(request.op) did not finish within \(budget) ms; XCUITest is still busy with it, so ops answer busy until it returns",
        retryable: true,
        detail: ["stage": "deadline", "op": .string(request.op), "budgetMs": .int(budget)]))
  }

  private func answerWhileBusy(
    _ request: Request, busy: Busy, health: (_ state: String, _ busy: JSON?) -> JSON
  ) -> Response {
    let busyMs = Int(now().timeIntervalSince(busy.since) * 1000)
    let busyJSON: JSON = ["op": .string(busy.op), "id": .string(busy.id), "ms": .int(busyMs)]
    switch request.op {
    case "health":
      return .success(id: request.id, data: health("busy", busyJSON))
    case "shutdown":
      return .success(id: request.id, data: [:])
    default:
      return .failure(
        id: request.id,
        error: WireError(
          .timeout, "runner busy: \(busy.op) has held XCUITest for \(busyMs) ms", retryable: true,
          detail: ["stage": "busy", "busyOp": .string(busy.op), "busyMs": .int(busyMs)]))
    }
  }
}

private final class ResponseBox: @unchecked Sendable {
  var value: Response?
}
