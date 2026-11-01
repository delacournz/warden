import Darwin
import XCTest

@testable import warden_simd

/// The line a socket-mode helper prints once it accepts connections, and what happens to stdout afterwards.
final class AnnounceTests: XCTestCase {
  func testReadyEventCarriesTheIdentityFieldsPlusSocketAndPid() {
    let event = Announce.readyEvent(
      fields: ["protocol": 1, "udid": "U", "hid": ["transport": "indigo"]], socket: "/tmp/x.sock", pid: 4242)
    guard case let .object(fields) = event.json else { return XCTFail("not an object") }
    XCTAssertEqual(fields["event"], "ready")
    XCTAssertEqual(fields["socket"], "/tmp/x.sock")
    XCTAssertEqual(fields["pid"], 4242)
    XCTAssertEqual(fields["udid"], "U")
    XCTAssertEqual(fields["protocol"], 1)
  }

  func testTheReadyLineIsOneNewlineTerminatedJSONObject() throws {
    let line = NDJSON.encodeLine(Announce.readyEvent(fields: ["udid": "U"], socket: "/s", pid: 7).json)
    XCTAssertEqual(line.last, 0x0A)
    XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
    let decoded = try JSONDecoder().decode(JSON.self, from: line)
    XCTAssertEqual(decoded, ["event": "ready", "udid": "U", "socket": "/s", "pid": 7])
  }

  func testOnlyPipesAndSocketsAreDetached() {
    XCTAssertTrue(Announce.isDetachable(mode: S_IFIFO | 0o600))
    XCTAssertTrue(Announce.isDetachable(mode: S_IFSOCK | 0o600))
    XCTAssertFalse(Announce.isDetachable(mode: S_IFREG | 0o644))
    XCTAssertFalse(Announce.isDetachable(mode: S_IFCHR | 0o620))
  }

  func testAPipeOnStdoutIsPointedAtTheLogSoALaterWriteSurvivesItsReaderLeaving() throws {
    var pipeFDs: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&pipeFDs), 0)
    let (reader, writer) = (pipeFDs[0], pipeFDs[1])
    let logPath = NSTemporaryDirectory() + "announce-\(UUID().uuidString).log"
    let log = open(logPath, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    defer {
      close(writer)
      close(log)
      unlink(logPath)
    }
    XCTAssertTrue(Announce.detach(writer, onto: log))
    close(reader)
    let bytes = Array("after\n".utf8)
    XCTAssertEqual(bytes.withUnsafeBytes { write(writer, $0.baseAddress, $0.count) }, bytes.count)
    XCTAssertEqual(try String(contentsOfFile: logPath, encoding: .utf8), "after\n")
  }

  func testARegularFileOnStdoutIsLeftAlone() throws {
    let path = NSTemporaryDirectory() + "announce-\(UUID().uuidString).out"
    let target = open(path + ".log", O_WRONLY | O_CREAT, 0o600)
    let file = open(path, O_WRONLY | O_CREAT, 0o600)
    defer {
      close(file)
      close(target)
      unlink(path)
      unlink(path + ".log")
    }
    XCTAssertFalse(Announce.detach(file, onto: target))
    let bytes = Array("kept\n".utf8)
    _ = bytes.withUnsafeBytes { write(file, $0.baseAddress, $0.count) }
    XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "kept\n")
  }
}
