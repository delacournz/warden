import Foundation
import Network

/// NDJSON over TCP: the `warden-simd` socket protocol on an `NWListener`, because a phone has no unix socket the Mac can
/// reach. Every callback runs on `queue` (the main queue in the runner, so XCUITest calls stay on the main thread);
/// requests on all connections are therefore served strictly one after another.
final class RunnerServer: @unchecked Sendable {
  private let queue: DispatchQueue
  private let port: UInt16
  private let readyFields: () -> [String: JSON]
  private let handle: (Request) -> Response
  private var listener: NWListener?
  private var connections: [ObjectIdentifier: NWConnection] = [:]

  /// Set after a `shutdown` request was answered. The runner's run loop watches it.
  private(set) var isDone = false
  /// Requests served so far; the idle timer reads it.
  private(set) var served = 0

  /// `port` 0 picks a free port; `boundPort` says which.
  init(
    port: UInt16, queue: DispatchQueue, readyFields: @escaping () -> [String: JSON],
    handle: @escaping (Request) -> Response
  ) {
    self.port = port
    self.queue = queue
    self.readyFields = readyFields
    self.handle = handle
  }

  private(set) var boundPort: UInt16?

  /// Starts listening; `onListening` runs on `queue` once the port is bound.
  func start(onListening: @escaping (UInt16) -> Void, onFailure: @escaping (any Error) -> Void) throws {
    let endpoint: NWEndpoint.Port = port == 0 ? .any : (NWEndpoint.Port(rawValue: port) ?? .any)
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    let listener = try NWListener(using: parameters, on: endpoint)
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
  }

  private func accept(_ connection: NWConnection) {
    let key = ObjectIdentifier(connection)
    connections[key] = connection
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.connections[key] = nil
      default: break
      }
    }
    connection.start(queue: queue)
    send(Event.ready(readyFields()).json, on: connection)
    receive(on: connection, buffer: LineBuffer())
  }

  private func receive(on connection: NWConnection, buffer: LineBuffer) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buffer = buffer
      if let data, !data.isEmpty {
        for line in buffer.append(data) {
          if self.serve(line: line, on: connection) { return }
        }
      }
      if isComplete || error != nil {
        if let tail = buffer.flush(), self.serve(line: tail, on: connection) { return }
        connection.cancel()
        return
      }
      self.receive(on: connection, buffer: buffer)
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
      served += 1
      response = handle(request)
      isShutdown = request.op == "shutdown"
    }
    send(response.json, on: connection) { [weak self] in
      guard isShutdown, let self else { return }
      self.isDone = true
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
