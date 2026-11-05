import CoreMedia
import CoreVideo
import VideoToolbox
import XCTest

@testable import warden_simd

final class AUFramingTests: XCTestCase {
  func testHeaderIsLengthFlagsPtsBigEndian() {
    let header = AUFraming.header(length: 0x0102_0304, flags: [.key, .config], ptsMicros: 0x0A0B_0C0D_0E0F_1011)
    XCTAssertEqual(
      [UInt8](header),
      [0x01, 0x02, 0x03, 0x04, 0b11, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11])
    XCTAssertEqual(AUFraming.headerLength, 13)
  }

  func testAvccToAnnexBPrefixesEveryNalAndLeadsKeyframesWithParameterSets() throws {
    let avcc: [UInt8] = [0, 0, 0, 2, 0x65, 0xAA, 0, 0, 0, 1, 0x06]
    let sps: [UInt8] = [0x67, 0x42]
    let pps: [UInt8] = [0x68, 0xCE]
    let key = try AUFraming.annexB(avcc: Data(avcc), parameterSets: [Data(sps), Data(pps)])
    XCTAssertEqual(
      [UInt8](key),
      [0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xCE, 0, 0, 0, 1, 0x65, 0xAA, 0, 0, 0, 1, 0x06])
    let delta = try AUFraming.annexB(avcc: Data([0, 0, 0, 1, 0x41]), parameterSets: [])
    XCTAssertEqual([UInt8](delta), [0, 0, 0, 1, 0x41])
  }

  func testTruncatedAvccIsRefused() {
    XCTAssertThrowsError(try AUFraming.annexB(avcc: Data([0, 0, 0, 5, 0x65]), parameterSets: []))
    XCTAssertThrowsError(try AUFraming.annexB(avcc: Data([0, 0]), parameterSets: []))
  }
}

final class FramePacerTests: XCTestCase {
  private let ms: UInt64 = 1_000_000

  func testFirstRenderEncodesAtOnceThenRendersAreCappedAtTheFrameRate() {
    var pacer = FramePacer(fps: 60, keepaliveMs: 1000)
    pacer.rendered()
    XCTAssertEqual(pacer.deadline(now: 0), 0)
    XCTAssertTrue(pacer.fire(now: 0))
    pacer.rendered()
    XCTAssertEqual(pacer.deadline(now: 5 * ms), 16_666_666)
    XCTAssertFalse(pacer.fire(now: 5 * ms))
    XCTAssertTrue(pacer.fire(now: 17 * ms))
  }

  func testAStillScreenOnlyGetsTheKeepalive() {
    var pacer = FramePacer(fps: 60, keepaliveMs: 1000)
    pacer.rendered()
    XCTAssertTrue(pacer.fire(now: 0))
    XCTAssertEqual(pacer.deadline(now: 10 * ms), 1000 * ms)
    XCTAssertFalse(pacer.fire(now: 500 * ms))
    XCTAssertTrue(pacer.fire(now: 1000 * ms))
    XCTAssertEqual(pacer.deadline(now: 1000 * ms), 2000 * ms)
  }

  func testRendersBetweenTicksCoalesceIntoOneFrame() {
    var pacer = FramePacer(fps: 30, keepaliveMs: 1000)
    pacer.rendered()
    XCTAssertTrue(pacer.fire(now: 0))
    pacer.rendered()
    pacer.rendered()
    pacer.rendered()
    XCTAssertTrue(pacer.fire(now: 34 * ms))
    XCTAssertEqual(pacer.deadline(now: 34 * ms), 1034 * ms, "nothing pending: next is the keepalive")
  }

  func testAForcedFrameGoesOutAtOnce() {
    var pacer = FramePacer(fps: 60, keepaliveMs: 1000)
    pacer.rendered()
    XCTAssertTrue(pacer.fire(now: 0))
    pacer.force()
    XCTAssertEqual(pacer.deadline(now: 1 * ms), 1 * ms)
    XCTAssertTrue(pacer.fire(now: 1 * ms))
  }

  func testNothingBeforeTheFirstSurfaceFrame() {
    var pacer = FramePacer(fps: 60, keepaliveMs: 1000)
    XCTAssertNil(pacer.deadline(now: 0))
    XCTAssertFalse(pacer.fire(now: 5000 * ms))
  }
}

final class StreamStartRequestTests: XCTestCase {
  func testDefaults() throws {
    let request = try StreamStartRequest(.object([:]))
    XCTAssertEqual(request, StreamStartRequest(fps: 60, bitrate: 4_000_000, maxEdge: 1280, keepaliveMs: 1000, path: nil))
  }

  func testExplicitValues() throws {
    let request = try StreamStartRequest(
      .object([
        "fps": .int(30), "bitrate": .int(2_000_000), "maxEdge": .int(0), "keepaliveMs": .int(250),
        "path": .string("/tmp/s.sock"),
      ]))
    XCTAssertEqual(request, StreamStartRequest(fps: 30, bitrate: 2_000_000, maxEdge: 0, keepaliveMs: 250, path: "/tmp/s.sock"))
  }

  func testOutOfRangeValuesAreBadRequests() {
    for params: [String: JSON] in [
      ["fps": .int(0)], ["fps": .int(61)], ["bitrate": .int(10_000)], ["bitrate": .int(50_000_000)],
      ["maxEdge": .int(100)], ["keepaliveMs": .int(10)], ["path": .string("")], ["fps": .string("60")],
    ] {
      XCTAssertThrowsError(try StreamStartRequest(.object(params)), "\(params)") { error in
        XCTAssertEqual((error as? WireError)?.code, .badRequest)
      }
    }
  }

  func testEncodeSizeKeepsAspectEvenAndUnderTheCap() {
    XCTAssertEqual(StreamStartRequest.encodeSize(width: 1206, height: 2622, maxEdge: 1280), .init(width: 588, height: 1280))
    XCTAssertEqual(StreamStartRequest.encodeSize(width: 1206, height: 2622, maxEdge: 0), .init(width: 1206, height: 2622))
    XCTAssertEqual(StreamStartRequest.encodeSize(width: 800, height: 600, maxEdge: 1280), .init(width: 800, height: 600))
    XCTAssertEqual(StreamStartRequest.encodeSize(width: 2622, height: 1206, maxEdge: 1280), .init(width: 1280, height: 588))
  }
}

/// The encoder end to end without a simulator: synthetic BGRA frames in, Annex-B out, decoded back by VideoToolbox.
final class StreamEncoderTests: XCTestCase {
  private func frame(width: Int, height: Int, shade: UInt8) throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
    XCTAssertEqual(
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &buffer), kCVReturnSuccess)
    let pixels = try XCTUnwrap(buffer)
    CVPixelBufferLockBaseAddress(pixels, [])
    let base = CVPixelBufferGetBaseAddress(pixels)!
    memset(base, Int32(shade), CVPixelBufferGetBytesPerRow(pixels) * height)
    CVPixelBufferUnlockBaseAddress(pixels, [])
    return pixels
  }

  func testEncodesConstrainedBaselineThatDecodesWithKeyframesOnRequest() async throws {
    let units = UnitSink()
    let encoder = try StreamEncoder(
      width: 320, height: 640, fps: 60, bitrate: 1_000_000, sink: { unit in units.append(unit) })
    for index in 0..<12 {
      if index == 6 { encoder.requestKeyframe() }
      try encoder.encode(try frame(width: 640, height: 1280, shade: UInt8(index * 20)), ptsMicros: UInt64(index) * 16_667)
    }
    encoder.flush()
    let got = units.all
    XCTAssertEqual(got.count, 12)
    XCTAssertTrue(got[0].flags.contains(.key) && got[0].flags.contains(.config), "first unit is an IDR with SPS/PPS")
    XCTAssertTrue(got[6].flags.contains(.key), "a requested keyframe is the next unit")
    XCTAssertEqual(got.filter { $0.flags.contains(.key) }.count, 2)
    XCTAssertEqual(got.map(\.ptsMicros), (0..<12).map { UInt64($0) * 16_667 })

    let sps = try XCTUnwrap(AUFraming.nals(got[0].data).first { $0.first.map { $0 & 0x1F } == 7 })
    XCTAssertEqual(sps[1], 66, "profile_idc 66: Baseline")
    XCTAssertNotEqual(sps[2] & 0x40, 0, "constraint_set1: Constrained Baseline")
    XCTAssertEqual(try decodedSize(got), CGSize(width: 320, height: 640))
  }

  /// Decodes every unit with VTDecompressionSession and returns the size of the last decoded frame.
  private func decodedSize(_ units: [EncodedUnit]) throws -> CGSize {
    let nals = AUFraming.nals(units[0].data)
    let params = nals.filter { [7, 8].contains($0[0] & 0x1F) }
    var format: CMFormatDescription?
    try params[0].withUnsafeBytes { sps in
      try params[1].withUnsafeBytes { pps in
        let pointers = [sps.baseAddress!.assumingMemoryBound(to: UInt8.self), pps.baseAddress!.assumingMemoryBound(to: UInt8.self)]
        let sizes = [params[0].count, params[1].count]
        let status = CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: nil, parameterSetCount: 2, parameterSetPointers: pointers, parameterSetSizes: sizes,
          nalUnitHeaderLength: 4, formatDescriptionOut: &format)
        guard status == noErr else { throw WireError(.internal, "format \(status)") }
      }
    }
    var session: VTDecompressionSession?
    XCTAssertEqual(
      VTDecompressionSessionCreate(
        allocator: nil, formatDescription: format!, decoderSpecification: nil, imageBufferAttributes: nil,
        outputCallback: nil, decompressionSessionOut: &session), noErr)
    var last = CGSize.zero
    var decoded = 0
    for unit in units {
      var avcc = Data()
      for nal in AUFraming.nals(unit.data) where ![7, 8].contains(nal[0] & 0x1F) {
        var length = UInt32(nal.count).bigEndian
        avcc.append(Data(bytes: &length, count: 4))
        avcc.append(nal)
      }
      var block: CMBlockBuffer?
      let bytes = UnsafeMutableRawPointer.allocate(byteCount: avcc.count, alignment: 1)
      avcc.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: avcc.count)
      CMBlockBufferCreateWithMemoryBlock(
        allocator: nil, memoryBlock: bytes, blockLength: avcc.count, blockAllocator: kCFAllocatorMalloc,
        customBlockSource: nil, offsetToData: 0, dataLength: avcc.count, flags: 0, blockBufferOut: &block)
      var sample: CMSampleBuffer?
      var size = avcc.count
      CMSampleBufferCreateReady(
        allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 0,
        sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
      let status = VTDecompressionSessionDecodeFrame(
        session!, sampleBuffer: sample!, flags: [], infoFlagsOut: nil
      ) { status, _, image, _, _ in
        if status == noErr, let image {
          decoded += 1
          last = CGSize(width: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image))
        }
      }
      XCTAssertEqual(status, noErr)
    }
    VTDecompressionSessionWaitForAsynchronousFrames(session!)
    VTDecompressionSessionInvalidate(session!)
    XCTAssertEqual(decoded, units.count, "every unit decodes")
    return last
  }
}

final class UnitSink: @unchecked Sendable {
  private let lock = NSLock()
  private var units: [EncodedUnit] = []
  func append(_ unit: EncodedUnit) { lock.withLock { units.append(unit) } }
  var all: [EncodedUnit] { lock.withLock { units } }
}

final class AUSocketTests: XCTestCase {
  private func socketPath() -> String { NSTemporaryDirectory() + "simd-stream-\(UUID().uuidString.prefix(8)).sock" }

  func testAReaderGetsFramedUnitsAndConnectingAsksForAKeyframe() async throws {
    let keyRequests = DropCounter()
    let socket = try AUSocket(path: socketPath(), maxQueued: 2, onNeedKeyframe: { keyRequests.bump() })
    defer { socket.close() }
    socket.send(EncodedUnit(data: Data([0, 0, 0, 1, 0x41]), flags: [], ptsMicros: 1))
    let client = try UnixClient(path: socket.path)
    try await socket.waitForClient(timeoutMs: 2000)
    XCTAssertEqual(keyRequests.count, 1, "a new reader starts on an IDR")
    socket.send(EncodedUnit(data: Data([0, 0, 0, 1, 0x65]), flags: [.key], ptsMicros: 7))
    let header = try client.read(count: AUFraming.headerLength)
    XCTAssertEqual([UInt8](header), [0, 0, 0, 5, 1, 0, 0, 0, 0, 0, 0, 0, 7], "units sent before a reader are not queued")
    XCTAssertEqual([UInt8](try client.read(count: 5)), [0, 0, 0, 1, 0x65])
  }

  func testAReaderThatFallsBehindIsDroppedToTheNextKeyframe() async throws {
    let keyRequests = DropCounter()
    let socket = try AUSocket(path: socketPath(), maxQueued: 2, onNeedKeyframe: { keyRequests.bump() })
    defer { socket.close() }
    let client = try UnixClient(path: socket.path)
    try await socket.waitForClient(timeoutMs: 2000)
    let big = Data(repeating: 7, count: 1 << 20)
    for index in 0..<64 { socket.send(EncodedUnit(data: big, flags: [], ptsMicros: UInt64(index))) }
    XCTAssertGreaterThan(socket.stats.dropped, 0, "the backlog is cut, never buffered")
    XCTAssertGreaterThan(keyRequests.count, 1, "each cut asks for a keyframe")
    _ = client
  }
}

final class DropCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func bump() { lock.withLock { value += 1 } }
  var count: Int { lock.withLock { value } }
}

/// A blocking unix-socket reader for the tests.
struct UnixClient {
  let fd: Int32
  init(path: String) throws {
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      _ = path.utf8CString.withUnsafeBytes { src in memcpy(raw.baseAddress!, src.baseAddress!, min(src.count, raw.count - 1)) }
    }
    let result = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard result == 0 else { throw WireError(.io, "connect \(errno)") }
  }
  func read(count: Int) throws -> Data {
    var out = Data()
    var buffer = [UInt8](repeating: 0, count: count)
    while out.count < count {
      let n = Darwin.read(fd, &buffer, count - out.count)
      guard n > 0 else { throw WireError(.io, "read \(n)") }
      out.append(contentsOf: buffer[0..<n])
    }
    return out
  }
}
