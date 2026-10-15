import Foundation

// warden-simd entry point. stdout carries NDJSON only; diagnostics go to stderr (or --log <file>) and `log` events.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

/// Everything after argument parsing. Returns the process exit code.
func runMain(_ arguments: Arguments) async -> Int32 {
  if arguments.mode == .version {
    print("warden-simd \(BuildInfo.version) (protocol \(BuildInfo.protocolVersion), idb \(BuildInfo.idb))")
    return ExitCode.ok
  }
  guard let udid = arguments.udid else { return ExitCode.usage }

  let output = OutputChannel.fileDescriptor(1)
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

  output.send(.ready(session.readyFields()))
  output.log(.info, "ready: \(udid) hid=\(session.hidTransport) bridge=\(session.bridge.name)")
  let server = StdioServer(dispatcher: .standard(), context: session, output: output)
  let code = await server.run(input: stdinChunks())
  await session.close()
  return code
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
  // FBSimulatorControl delivers CoreSimulator callbacks on the main queue, so keep it serviced.
  Task {
    let code = await runMain(arguments)
    exit(code)
  }
  dispatchMain()
}
