import Foundation

// warden-simd entry point. stdout carries NDJSON only; diagnostics go to stderr (or --log <file>) and `log` events.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

/// SIGTERM / SIGINT: what to do depends on how far startup got. Before a mode installs its handler the process just
/// exits; afterwards the handler tears the mode down cleanly (socket unlinked, HID closed).
final class SignalTerminator: @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable () -> Void)?

  func install(_ new: @escaping @Sendable () -> Void) { lock.withLock { handler = new } }

  func fire() {
    let current = lock.withLock { handler }
    if let current { current() } else { exit(ExitCode.ok) }
  }
}

let terminator = SignalTerminator()

/// Everything after argument parsing. Returns the process exit code.
func runMain(_ arguments: Arguments) async -> Int32 {
  if arguments.mode == .version {
    print("warden-simd \(BuildInfo.version) (protocol \(BuildInfo.protocolVersion), idb \(BuildInfo.idb))")
    return ExitCode.ok
  }
  guard let udid = arguments.udid else { return ExitCode.usage }

  let output = OutputChannel.fileDescriptor(1)
  OpLog.shared.attach(output)
  let executable = Bundle.main.executableURL?.resolvingSymlinksInPath()
  let resources = arguments.resources ?? executable?.deletingLastPathComponent().appendingPathComponent("Resources").path
    ?? "Resources"
  let options = SessionOptions(resources: resources, hid: arguments.hid, ax: arguments.ax)

  let session: Session
  do {
    session = try await Session.open(udid: udid, options: options)
  } catch {
    output.send(.fatal(WireError.from(error)))
    return ExitCode.bootstrap
  }

  if arguments.mode == .health {
    let data = await session.health(probe: true)
    output.send(Response.success(id: nil, data: data).json)
    await session.close()
    return ExitCode.ok
  }

  Task { await session.warmQuiescence() }

  if let socketPath = arguments.socket {
    return await runSocket(session: session, path: socketPath, idleTimeout: arguments.idleTimeout, output: output)
  }

  terminator.install {
    Task {
      await session.close()
      exit(ExitCode.ok)
    }
  }
  output.send(.ready(session.readyFields()))
  output.log(.info, "ready: \(udid) hid=\(session.hidTransport) bridge=\(session.bridge.name)")
  let server = StdioServer(dispatcher: .standard(), context: session, output: output)
  let code = await server.run(input: stdinChunks())
  await session.close()
  return code
}

/// Socket mode: listen, serve any number of clients, exit on `shutdown` / idle timeout / SIGTERM.
func runSocket(session: Session, path: String, idleTimeout: Int, output: OutputChannel) async -> Int32 {
  let tracker = IdleTracker(timeout: TimeInterval(idleTimeout))
  let server = SocketServer(
    path: path, dispatcher: Dispatcher<Session>.standard(), context: session, tracker: tracker,
    ready: { session.readyFields() })
  session.socket.attach(path: path, tracker: tracker)
  do {
    try server.start()
  } catch {
    let message = (error as? UnixSocket.Failure)?.message ?? error.localizedDescription
    output.send(.fatal(WireError(.io, message)))
    await session.close()
    return ExitCode.bootstrap
  }
  terminator.install { server.requestStop(.signal) }
  output.log(.info, "listening on \(path) (idle timeout \(idleTimeout)s)")
  let reason = await server.run()
  output.log(.info, "stopping: \(reason.rawValue)")
  await session.close()
  return ExitCode.ok
}

switch Arguments.parse(Array(CommandLine.arguments.dropFirst())) {
case let .failure(failure):
  FileHandle.standardError.write(Data("warden-simd: \(failure.message)\n\(Arguments.usage)\n".utf8))
  exit(ExitCode.usage)
case let .success(arguments):
  if arguments.verbose {
    setenv("FBCONTROLCORE_LOGGING", "1", 1)
    setenv("FBCONTROLCORE_DEBUG_LOGGING", "1", 1)
  }
  if let log = arguments.log {
    if freopen(log, "a", stderr) == nil {
      FileHandle.standardError.write(Data("warden-simd: cannot open log file \(log)\n".utf8))
      exit(ExitCode.usage)
    }
  }
  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let signalSources = [SIGTERM, SIGINT].map { number -> any DispatchSourceSignal in
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { terminator.fire() }
    source.resume()
    return source
  }
  withExtendedLifetime(signalSources) {}
  // FBSimulatorControl delivers CoreSimulator callbacks on the main queue, so keep it serviced.
  Task {
    let code = await runMain(arguments)
    exit(code)
  }
  dispatchMain()
}
