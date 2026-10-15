import Foundation

/// Op table. Generic over the context so the table (and timeouts / error mapping) can be tested without a
/// simulator; production uses `Dispatcher<Session>`, i.e. `[String: (Session, JSON) async throws -> JSON]`.
///
/// Adding ops: define `static let ops: [String: Dispatcher<Session>.OpHandler]` in `Ops/<Name>.swift` and add it to
/// `Dispatcher<Session>.standard()` below. The dispatcher itself never changes shape.
struct Dispatcher<Context: Sendable>: Sendable {
  typealias OpHandler = @Sendable (Context, JSON) async throws -> JSON

  /// The op that ends the session; the server stops reading after answering it.
  static var shutdownOp: String { "shutdown" }

  var handlers: [String: OpHandler]

  init(handlers: [String: OpHandler]) {
    self.handlers = handlers
  }

  /// Unknown ops are `E_BAD_REQUEST`; handler errors go through `mapError`; `timeoutMs` races the handler.
  func handle(
    _ request: Request, context: Context, mapError: @Sendable (any Error) -> WireError = { WireError.from($0) }
  ) async -> Response {
    guard let handler = handlers[request.op] else {
      return .failure(id: request.id, error: WireError(.badRequest, "unknown op \"\(request.op)\""))
    }
    do {
      let params = request.params
      let data: JSON
      if let timeoutMs = request.timeoutMs {
        let op = request.op
        data = try await withTimeout(milliseconds: timeoutMs, error: {
          WireError(.timeout, "op \"\(op)\" timed out after \(timeoutMs) ms")
        }) { try await handler(context, params) }
      } else {
        data = try await handler(context, params)
      }
      return .success(id: request.id, data: data)
    } catch {
      return .failure(id: request.id, error: mapError(error))
    }
  }
}

/// First of `body` / the timer wins. A body that ignores cancellation keeps running in the background, but the
/// caller is answered on time.
func withTimeout<T: Sendable>(
  milliseconds: Int,
  error makeError: @escaping @Sendable () -> WireError,
  _ body: @escaping @Sendable () async throws -> T
) async throws -> T {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, any Error>) in
    let gate = OnceGate(continuation)
    let work = Task { try await body() }
    let timer = Task {
      do { try await Task.sleep(for: .milliseconds(milliseconds)) } catch { return }
      work.cancel()
      gate.fail(makeError())
    }
    Task {
      do {
        let value = try await work.value
        timer.cancel()
        gate.succeed(value)
      } catch {
        timer.cancel()
        gate.fail(error)
      }
    }
  }
}

/// Resumes a continuation at most once.
private final class OnceGate<T: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<T, any Error>?

  init(_ continuation: CheckedContinuation<T, any Error>) {
    self.continuation = continuation
  }

  private func take() -> CheckedContinuation<T, any Error>? {
    lock.lock()
    defer { lock.unlock() }
    let taken = continuation
    continuation = nil
    return taken
  }

  func succeed(_ value: T) { take()?.resume(returning: value) }
  func fail(_ error: any Error) { take()?.resume(throwing: error) }
}

extension Dispatcher where Context == Session {
  /// Every op the helper serves. Later phases append their `Ops/*.swift` tables here.
  static func standard() -> Dispatcher<Session> {
    var handlers: [String: OpHandler] = [:]
    for table in [HealthOps.ops] {
      handlers.merge(table) { _, new in new }
    }
    return Dispatcher(handlers: handlers)
  }
}
