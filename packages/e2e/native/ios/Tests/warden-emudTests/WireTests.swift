import Foundation
import XCTest

@testable import WardenEmu
import WardenStream

final class ProtoTests: XCTestCase {
  func testScreenshotRequestIsRgb888AtTheSizeOverMmap() {
    let encoded = ScreenshotRequest(width: 540, height: 1212, mmapPath: "/t/f.rgb").encoded
    var seen: [UInt64: UInt64] = [:]
    var transport: [UInt8]?
    XCTAssertTrue(
      Proto.fields(Array(encoded)) { number, value, bytes in
        if let value { seen[number] = value }
        if number == 6 { transport = bytes }
      })
    XCTAssertEqual(seen, [1: 2, 3: 540, 4: 1212])
    var channel: UInt64?
    var handle: String?
    XCTAssertTrue(
      Proto.fields(transport ?? []) { number, value, bytes in
        if number == 1 { channel = value }
        if number == 2, let bytes { handle = String(decoding: bytes, as: UTF8.self) }
      })
    XCTAssertEqual(channel, 1)
    XCTAssertEqual(handle, "file:///t/f.rgb")
  }

  func testImageHeaderRoundTripsAndRejectsGarbage() {
    let header = ImageHeader(width: 540, height: 1212, seq: 300, timestampUs: 1_700_000_000_000_000)
    XCTAssertEqual(ImageHeader.decode(header.encoded), header)
    XCTAssertNil(ImageHeader.decode(Data([0x0A, 0x7F])))
  }

  func testVarintRoundTrip() {
    for value: UInt64 in [0, 1, 127, 128, 300, 1 << 35, .max] {
      var index = 0
      XCTAssertEqual(Proto.readVarint(Proto.varint(value), &index), value)
    }
    var index = 0
    XCTAssertNil(Proto.readVarint([0x80, 0x80], &index))
  }
}

final class H2Tests: XCTestCase {
  func testHpackIntegerRfc7541Examples() {
    XCTAssertEqual(H2.hpackInteger(10, prefixBits: 5), [10])
    XCTAssertEqual(H2.hpackInteger(1337, prefixBits: 5), [31, 154, 10])
    XCTAssertEqual(H2.hpackInteger(42, prefixBits: 8), [42])
  }

  func testHeaderBlockIsLiteralsWithoutIndexing() {
    XCTAssertEqual(Array(H2.headerBlock([("te", "trailers")])), [0x00, 2] + Array("te".utf8) + [8] + Array("trailers".utf8))
    let long = String(repeating: "x", count: 200)
    XCTAssertEqual(Array(H2.headerBlock([("a", long)]).prefix(5)), [0x00, 1, UInt8(ascii: "a"), 127, 73])
  }

  func testFrameReaderSplitsAcrossPushes() {
    let one = H2.frame(.data, flags: H2.Flag.endStream, stream: 1, payload: Data([1, 2, 3]))
    let two = H2.frame(.ping, payload: Data(repeating: 7, count: 8))
    var reader = H2.FrameReader()
    let joined = one + two
    XCTAssertEqual(reader.push(joined.prefix(5)), [])
    let frames = reader.push(joined.dropFirst(5))
    XCTAssertEqual(frames.map(\.type), [0, 6])
    XCTAssertEqual(frames.first?.stream, 1)
    XCTAssertEqual(frames.first?.payload, Data([1, 2, 3]))
    XCTAssertEqual(frames.last?.payload.count, 8)
  }

  func testPaddedDataLosesItsPadding() {
    let frame = H2.Frame(type: 0, flags: H2.Flag.padded, stream: 1, payload: Data([2, 9, 9, 0, 0]))
    XCTAssertEqual(frame.dataPayload, Data([9, 9]))
    XCTAssertNil(H2.Frame(type: 0, flags: H2.Flag.padded, stream: 1, payload: Data([5, 1])).dataPayload)
  }

  func testGrpcMessagesAcrossChunks() {
    let framed = GrpcMessageReader.frame(Data([1, 2])) + GrpcMessageReader.frame(Data([3]))
    var reader = GrpcMessageReader()
    XCTAssertEqual(reader.push(framed.prefix(6)), [])
    XCTAssertEqual(reader.push(framed.dropFirst(6)), [Data([1, 2]), Data([3])])
    XCTAssertFalse(reader.compressed)
  }
}

final class EmuServerTests: XCTestCase {
  private func reply(_ server: EmuServer, _ json: String) -> [String: Any] {
    let data = server.handle(line: Data(json.utf8))
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }

  private func code(_ reply: [String: Any]) -> String? {
    (reply["error"] as? [String: Any])?["code"] as? String
  }

  func testStartParamsAreValidatedLikeTheIosHelper() {
    let server = EmuServer(token: "t", frameDir: NSTemporaryDirectory(), defaultPath: { _ in "/tmp/x.sock" })
    for params in [
      #""port":0,"width":540,"height":1212"#, #""port":8554,"width":541,"height":1212"#,
      #""port":8554,"width":540,"height":1212,"fps":61"#, #""port":8554,"height":1212"#,
      #""port":8554,"width":540,"height":1212,"bitrate":true"#,
    ] {
      XCTAssertEqual(code(reply(server, #"{"id":"1","op":"stream.start","# + params + "}")), "E_BAD_REQUEST", params)
    }
  }

  func testNoTokenNoStreamUnknownOp() {
    let server = EmuServer(token: nil, frameDir: NSTemporaryDirectory(), defaultPath: { _ in "/tmp/x.sock" })
    let start = reply(server, #"{"id":"1","op":"stream.start","port":8554,"width":540,"height":1212}"#)
    XCTAssertEqual(code(start), "E_BAD_REQUEST")
    XCTAssertTrue(((start["error"] as? [String: Any])?["message"] as? String ?? "").contains(EmuServer.tokenEnv))
    XCTAssertEqual(code(reply(server, #"{"id":"2","op":"stream.keyframe"}"#)), "E_BAD_REQUEST")
    XCTAssertEqual(code(reply(server, #"{"id":"3","op":"nope"}"#)), "E_BAD_REQUEST")
    let stop = reply(server, #"{"id":"4","op":"stream.stop"}"#)
    XCTAssertEqual(stop["ok"] as? Bool, true)
    XCTAssertEqual((stop["data"] as? [String: Any])?["stopped"] as? Bool, false)
    XCTAssertEqual(reply(server, "[1]")["ok"] as? Bool, false)
  }

  func testConnectRefusedIsEIo() throws {
    let port = try FakeBridge.unusedPort()
    let server = EmuServer(token: "t", frameDir: NSTemporaryDirectory(), defaultPath: { _ in NSTemporaryDirectory() + "wemu-refused.sock" })
    XCTAssertEqual(code(reply(server, #"{"id":"1","op":"stream.start","port":\#(port),"width":64,"height":128}"#)), "E_IO")
  }
}
