import Foundation
import WardenEmu

// warden-emud: live H.264 of an Android emulator's display, fed by the emulator's gRPC screenshot stream and encoded
// with VideoToolbox, on the same unit socket and op shapes as warden-simd's stream.*. NDJSON on stdin/stdout; exits
// when stdin closes.
signal(SIGPIPE, SIG_IGN)
let environment = ProcessInfo.processInfo.environment
let temp = (environment["TMPDIR"] ?? NSTemporaryDirectory()).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
let tempDir = "/" + temp
let server = EmuServer(
  token: environment[EmuServer.tokenEnv], frameDir: tempDir,
  defaultPath: { request in "\(tempDir)/wemu-\(request.port).sock" })
let output = FileHandle.standardOutput
output.write(EmuServer.readyLine)
while let line = readLine(strippingNewline: true) {
  if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
  output.write(server.handle(line: Data(line.utf8)))
}
server.shutdown()
