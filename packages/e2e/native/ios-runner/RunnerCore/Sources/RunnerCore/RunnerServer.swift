import Foundation
import Network

/// The first line of every connection: `{"op":"auth","token":"<the session token>"}`. The host makes the token (32
/// random bytes, hex) for one runner session and hands it over as `WARDEN_RUNNER_TOKEN`; it is never printed.
enum RunnerAuth {
  static let tokenVariable = "WARDEN_RUNNER_TOKEN"
  /// The shortest token a runner serves with (16 bytes as hex); the host sends 64 characters.
  static let minTokenLength = 32
  /// An auth line is ~90 bytes; a first line longer than this is not one.
  static let maxLineBytes = 1024
  /// How long a connection may stay silent before its auth line.
  static let timeout: TimeInterval = 5

  static func isUsable(token: String) -> Bool { token.utf8.count >= minTokenLength }

  /// The session token in the runner's environment, or nil when there is none it can serve with.
  static func token(in environment: [String: String]) -> String? {
    guard let token = environment[tokenVariable], isUsable(token: token) else { return nil }
    return token
  }

  /// Whether `line` is the auth line carrying exactly `token`.
  static func accepts(line: Data, token: String) -> Bool {
    guard line.count <= maxLineBytes, let value = try? JSONDecoder().decode(JSON.self, from: line),
      case let .object(fields) = value, fields["op"]?.stringValue == "auth", let offered = fields["token"]?.stringValue
    else { return false }
    return sameBytes(Array(offered.utf8), Array(token.utf8))
  }

  /// Equality in time that depends on the length of `expected` only, never on where the two differ.
  static func sameBytes(_ offered: [UInt8], _ expected: [UInt8]) -> Bool {
    var difference: UInt8 = offered.count == expected.count ? 0 : 1
    for index in expected.indices {
      difference |= (offered.isEmpty ? 0xFF : offered[index % offered.count]) ^ expected[index]
    }
    return difference == 0
  }
}

enum RunnerServerError: Error, CustomStringConvertible {
  case noToken

  var description: String {
    switch self {
    case .noToken:
      "no session token: start the runner with \(RunnerAuth.tokenVariable) set (at least \(RunnerAuth.minTokenLength) characters)"
    }
  }
}

/// NDJSON over TCP: the `warden-simd` socket protocol on an `NWListener`, because a phone has no unix socket the Mac can
/// reach. Every callback runs on `queue`, a serial transport queue, so requests on all connections are served strictly one
/// after another. The runner's `handle` hands each op to `WorkGate`, which runs it on the main thread under a deadline:
/// the transport queue never runs XCUITest itself, so a wedged op cannot stop it answering.
///
/// A connection is served only after its first line is the auth line with the session token (`RunnerAuth`). Until
/// then the server writes nothing; the `ready` event is the answer to a good auth line. Any other first line, a first
/// line over `RunnerAuth.maxLineBytes`, or `authTimeout` seconds without one closes the connection, and no op runs.
/// `loopbackOnly` binds `127.0.0.1` (a Simulator runner, reached from this Mac); a phone's runner is reached through
/// the CoreDevice tunnel, so it listens on every interface and the token is what admits a client.
final class RunnerServer: @unchecked Sendable {
  private let queue: DispatchQueue
  private let port: UInt16
  private let token: String
  private let loopbackOnly: Bool
  private let authTimeout: TimeInterval
  private var authenticated: Set<ObjectIdentifier> = []
  private let readyFields: () -> [String: JSON]
  private let handle: (Request) -> Response
  private var listener: NWListener?
  private var connections: [ObjectIdentifier: NWConnection] = [:]

  private let state = NSLock()
  private var done = false
  private var count = 0

  /// Set after a `shutdown` request was answered. The runner's run loop (another thread) watches it.
  var isDone: Bool { state.withLock { done } }
  /// Requests served so far; the idle timer (another thread) reads it.
  var served: Int { state.withLock { count } }

  /// `port` 0 picks a free port; `boundPort` says which.
  init(
    port: UInt16, queue: DispatchQueue, token: String, loopbackOnly: Bool,
    authTimeout: TimeInterval = RunnerAuth.timeout, readyFields: @escaping () -> [String: JSON],
    handle: @escaping (Request) -> Response
  ) {
    self.port = port
    self.queue = queue
    self.token = token
    self.loopbackOnly = loopbackOnly
    self.authTimeout = authTimeout
    self.readyFields = readyFields
    self.handle = handle
  }

  private(set) var boundPort: UInt16?

  /// Starts listening; `onListening` runs on `queue` once the port is bound. Throws without a usable token.
  func start(onListening: @escaping (UInt16) -> Void, onFailure: @escaping (any Error) -> Void) throws {
    guard RunnerAuth.isUsable(token: token) else { throw RunnerServerError.noToken }
    let endpoint: NWEndpoint.Port = port == 0 ? .any : (NWEndpoint.Port(rawValue: port) ?? .any)
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    let listener: NWListener
    if loopbackOnly {
      parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: endpoint)
      listener = try NWListener(using: parameters)
    } else {
      listener = try NWListener(using: parameters, on: endpoint)
    }
    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        let bound = listener.port?.rawValue ?? self.port
        self.boundPort = bound
        onListening(bound)
      case let .failed(error):
        onFailure(error)
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    self.listener = listener
    listener.start(queue: queue)
  }

  func stop() {
    listener?.cancel()
    listener = nil
    for connection in connections.values { connection.cancel() }
    connections.removeAll()
    authenticated.removeAll()
  }

  private func accept(_ connection: NWConnection) {
    let key = ObjectIdentifier(connection)
    connections[key] = connection
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled:
        self?.connections[key] = nil
        self?.authenticated.remove(key)
      default: break
      }
    }
    connection.start(queue: queue)
    queue.asyncAfter(deadline: .now() + authTimeout) { [weak self, weak connection] in
      guard let self, let connection, self.connections[key] != nil, !self.authenticated.contains(key) else { return }
      connection.cancel()
    }
    receive(on: connection, buffer: LineBuffer(), unauthenticatedBytes: 0)
  }

  /// `unauthenticatedBytes`: what the connection sent so far without completing its auth line.
  private func receive(on connection: NWConnection, buffer: LineBuffer, unauthenticatedBytes: Int) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      let key = ObjectIdentifier(connection)
      var buffer = buffer
      var pending = unauthenticatedBytes
      if let data, !data.isEmpty {
        for line in buffer.append(data) {
          if self.authenticated.contains(key) {
            if self.serve(line: line, on: connection) { return }
          } else if RunnerAuth.accepts(line: line, token: self.token) {
            self.authenticated.insert(key)
            self.send(Event.ready(self.readyFields()).json, on: connection)
          } else {
            connection.cancel()
            return
          }
        }
        if !self.authenticated.contains(key) {
          pending += data.count
          if pending > RunnerAuth.maxLineBytes {
            connection.cancel()
            return
          }
        }
      }
      if isComplete || error != nil {
        if self.authenticated.contains(key), let tail = buffer.flush(), self.serve(line: tail, on: connection) { return }
        connection.cancel()
        return
      }
      self.receive(on: connection, buffer: buffer, unauthenticatedBytes: pending)
    }
  }

  /// Returns true when the request was `shutdown` (the connection is closed after the reply).
  private func serve(line: Data, on connection: NWConnection) -> Bool {
    let response: Response
    let isShutdown: Bool
    switch NDJSON.parseRequest(line: line) {
    case let .failure(failure):
      response = .failure(id: failure.id, error: failure.error)
      isShutdown = false
    case let .success(request):
      state.withLock { count += 1 }
      response = handle(request)
      isShutdown = request.op == "shutdown"
    }
    send(response.json, on: connection) { [weak self] in
      guard isShutdown, let self else { return }
      self.state.withLock { self.done = true }
      connection.cancel()
    }
    return isShutdown
  }

  private func send(_ json: JSON, on connection: NWConnection, then: (@Sendable () -> Void)? = nil) {
    connection.send(
      content: NDJSON.encodeLine(json),
      completion: .contentProcessed { _ in
        if let then { then() }
      })
  }
}
