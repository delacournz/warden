import Foundation
import XCTest

@testable import WardenEmu
import WardenStream

final class SessionTests: XCTestCase {
  private func readUnits(_ path: String, count: Int, timeout: TimeInterval = 10) throws -> [(flags: UInt8, length: Int)] {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      for (i, byte) in path.utf8.enumerated() where i < raw.count - 1 { raw[i] = byte }
    }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 else { throw NSError(domain: "connect", code: Int(errno)) }
    defer { close(fd) }
    var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var buffer = Data()
    var units: [(UInt8, Int)] = []
    var chunk = [UInt8](repeating: 0, count: 65536)
    while units.count < count {
      let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      guard n > 0 else { throw NSError(domain: "read", code: Int(n)) }
      buffer.append(contentsOf: chunk[0..<n])
      while buffer.count >= AUFraming.headerLength {
        let bytes = Array(buffer.prefix(AUFraming.headerLength))
        let length = Int(bytes[0]) << 24 | Int(bytes[1]) << 16 | Int(bytes[2]) << 8 | Int(bytes[3])
        guard buffer.count >= AUFraming.headerLength + length else { break }
        units.append((bytes[4], length))
        buffer = buffer.dropFirst(AUFraming.headerLength + length)
      }
    }
    return units
  }

  func testFramesFromTheBridgeLeaveAsH264UnitsKeyframeFirst() throws {
    let bridge = try FakeBridge()
    defer { bridge.close() }
    bridge.serve()
    let path = NSTemporaryDirectory() + "wemu-test-\(getpid()).sock"
    let request = EmuStartRequest(port: bridge.port, width: 64, height: 128, fps: 60, keepaliveMs: 100, path: path)
    let feeder = Thread {
      guard bridge.waitForRequest() else { return }
      bridge.send(H2.settings([]))
      bridge.send(H2.frame(.ping, payload: Data([1, 2, 3, 4, 5, 6, 7, 8])))
      bridge.frame(width: 64, height: 128, seq: 1, rgb: (255, 0, 0))
    }
    feeder.start()
    let session = try EmuStreamSession.start(request: request, token: "secret-token", defaultPath: path, frameDir: NSTemporaryDirectory())
    defer { session.stop() }
    XCTAssertEqual(session.encodeSize.width, 64)
    XCTAssertEqual(session.encodeSize.height, 128)
    let block = String(decoding: bridge.headerBlock, as: UTF8.self)
    XCTAssertTrue(block.contains("Bearer secret-token"))
    XCTAssertTrue(block.contains(ScreenshotCall.path))

    let units = try readUnits(path, count: 2)
    XCTAssertEqual(units.first?.flags, AUFlags.key.rawValue | AUFlags.config.rawValue)
    bridge.frame(width: 64, height: 128, seq: 3, rgb: (0, 0, 255))
    Thread.sleep(forTimeInterval: 0.2)
    let stats = session.stats
    XCTAssertEqual(stats["rendered"] as? Int, 2)
    XCTAssertEqual(stats["seqSkipped"] as? Int, 1)
    XCTAssertGreaterThanOrEqual(stats["keyframes"] as? Int ?? 0, 1)
    XCTAssertTrue(bridge.sawSettingsAck)
    XCTAssertEqual(bridge.pingAck, Data([1, 2, 3, 4, 5, 6, 7, 8]))
  }

  func testRotationRebuildsTheEncoderAtTheNewSize() throws {
    let bridge = try FakeBridge()
    defer { bridge.close() }
    bridge.serve()
    let path = NSTemporaryDirectory() + "wemu-rot-\(getpid()).sock"
    let feeder = Thread {
      guard bridge.waitForRequest() else { return }
      bridge.frame(width: 64, height: 128, seq: 1, rgb: (0, 255, 0))
    }
    feeder.start()
    let session = try EmuStreamSession.start(
      request: EmuStartRequest(port: bridge.port, width: 64, height: 128, path: path), token: "t", defaultPath: path,
      frameDir: NSTemporaryDirectory())
    defer { session.stop() }
    bridge.frame(width: 128, height: 64, seq: 2, rgb: (0, 255, 0))
    let deadline = Date().addingTimeInterval(3)
    while session.encodeSize.width != 128 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
    XCTAssertEqual(session.encodeSize.width, 128)
    XCTAssertEqual(session.encodeSize.height, 64)
  }

  func testAnOddFrameSizeIsEncodedAtEvenSides() throws {
    let bridge = try FakeBridge()
    defer { bridge.close() }
    bridge.serve()
    let path = NSTemporaryDirectory() + "wemu-odd-\(getpid()).sock"
    let feeder = Thread {
      guard bridge.waitForRequest() else { return }
      bridge.frame(width: 64, height: 127, seq: 1, rgb: (9, 9, 9))
    }
    feeder.start()
    let session = try EmuStreamSession.start(
      request: EmuStartRequest(port: bridge.port, width: 64, height: 128, path: path), token: "t", defaultPath: path,
      frameDir: NSTemporaryDirectory())
    defer { session.stop() }
    XCTAssertEqual(session.encodeSize.width, 64)
    XCTAssertEqual(session.encodeSize.height, 126)
    XCTAssertEqual(session.stats["frameHeight"] as? Int, 127)
    XCTAssertEqual(try readUnits(path, count: 1).first?.flags, AUFlags.key.rawValue | AUFlags.config.rawValue)
  }

  func testAStreamThatEndsBeforeAFrameFailsStartWithTheReason() throws {
    let bridge = try FakeBridge()
    defer { bridge.close() }
    bridge.serve()
    let feeder = Thread {
      guard bridge.waitForRequest() else { return }
      bridge.send(H2.frame(.headers, flags: H2.Flag.endHeaders | H2.Flag.endStream, stream: 1, payload: Data([0x88])))
    }
    feeder.start()
    let path = NSTemporaryDirectory() + "wemu-end-\(getpid()).sock"
    XCTAssertThrowsError(
      try EmuStreamSession.start(
        request: EmuStartRequest(port: bridge.port, width: 64, height: 128, path: path), token: "bad", defaultPath: path,
        frameDir: NSTemporaryDirectory())
    ) { error in
      XCTAssertEqual((error as? StreamError)?.code, .io)
      XCTAssertTrue((error as? StreamError)?.message.contains("trailers") ?? false)
    }
  }

  func testNoFrameInTimeIsETimeout() throws {
    let bridge = try FakeBridge()
    defer { bridge.close() }
    bridge.serve()
    let path = NSTemporaryDirectory() + "wemu-slow-\(getpid()).sock"
    XCTAssertThrowsError(
      try EmuStreamSession.start(
        request: EmuStartRequest(port: bridge.port, width: 64, height: 128, path: path, firstFrameTimeoutMs: 200), token: "t",
        defaultPath: path, frameDir: NSTemporaryDirectory())
    ) { error in XCTAssertEqual((error as? StreamError)?.code, .timeout) }
  }
}
