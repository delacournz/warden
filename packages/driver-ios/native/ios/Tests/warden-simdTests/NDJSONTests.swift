import XCTest

@testable import warden_simd

final class NDJSONTests: XCTestCase {
  private func parse(_ text: String) -> Result<Request, RequestParseFailure> {
    NDJSON.parseRequest(line: Data(text.utf8))
  }

  private func failure(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> RequestParseFailure? {
    guard case let .failure(failure) = parse(text) else {
      XCTFail("expected a parse failure", file: file, line: line)
      return nil
    }
    return failure
  }

  // MARK: - Request parsing

  func testParsesRequestKeepingAllParams() throws {
    let request = try parse(#"{"id":"7","op":"tap","x":10.5,"y":20,"timeoutMs":2500}"#).get()
    XCTAssertEqual(request.id, "7")
    XCTAssertEqual(request.op, "tap")
    XCTAssertEqual(request.timeoutMs, 2500)
    XCTAssertEqual(request.params["x"]?.doubleValue, 10.5)
    XCTAssertEqual(request.params["y"]?.intValue, 20)
  }

  func testIdsAreOpaqueStrings() throws {
    let request = try parse(#"{"id":"a-b/c:1","op":"health"}"#).get()
    XCTAssertEqual(request.id, "a-b/c:1")
    XCTAssertNil(request.timeoutMs)
  }

  func testInvalidJSONIsBadRequestWithoutId() {
    let failure = failure("{not json")
    XCTAssertEqual(failure?.error.code, .badRequest)
    XCTAssertNil(failure?.id)
  }

  func testNonObjectIsBadRequest() {
    XCTAssertEqual(failure("[1,2]")?.error.code, .badRequest)
    XCTAssertEqual(failure("42")?.error.code, .badRequest)
  }

  func testMissingOrNonStringIdIsBadRequestWithNilId() {
    XCTAssertEqual(failure(#"{"op":"health"}"#)?.error.code, .badRequest)
    let numeric = failure(#"{"id":1,"op":"health"}"#)
    XCTAssertEqual(numeric?.error.code, .badRequest)
    XCTAssertNil(numeric?.id)
    XCTAssertEqual(failure(#"{"id":"","op":"health"}"#)?.error.code, .badRequest)
  }

  func testMissingOpKeepsTheIdSoTheCallerGetsAnswered() {
    let failure = failure(#"{"id":"9"}"#)
    XCTAssertEqual(failure?.id, "9")
    XCTAssertEqual(failure?.error.code, .badRequest)
  }

  func testBadTimeoutIsRejected() {
    XCTAssertEqual(failure(#"{"id":"1","op":"x","timeoutMs":0}"#)?.error.code, .badRequest)
    XCTAssertEqual(failure(#"{"id":"1","op":"x","timeoutMs":"soon"}"#)?.error.code, .badRequest)
    XCTAssertEqual(failure(#"{"id":"1","op":"x","timeoutMs":-5}"#)?.id, "1")
  }

  // MARK: - Encoding

  func testEncodeIsOneCompactSortedLine() {
    let line = NDJSON.encodeLine(["b": 1, "a": ["x/y", true, nil]])
    XCTAssertEqual(String(decoding: line, as: UTF8.self), "{\"a\":[\"x/y\",true,null],\"b\":1}\n")
  }

  func testIntegersStayIntegersAndFractionsStayFractions() throws {
    let line = NDJSON.encodeLine(["i": .int(3), "d": .double(2.5)])
    XCTAssertEqual(String(decoding: line, as: UTF8.self), "{\"d\":2.5,\"i\":3}\n")
    let back = try JSONDecoder().decode(JSON.self, from: line)
    XCTAssertEqual(back["i"], .int(3))
    XCTAssertEqual(back["d"], .double(2.5))
  }

  func testSuccessResponseShape() throws {
    let json = Response.success(id: "1", data: ["ok": true]).json
    XCTAssertEqual(json, ["id": "1", "ok": true, "data": ["ok": true]])
  }

  func testFailureResponseShapeCarriesCodeMessageRetryableDetail() {
    let error = WireError(.noElement, "nothing at 1,2", detail: ["x": 1])
    let json = Response.failure(id: "2", error: error).json
    XCTAssertEqual(
      json,
      [
        "id": "2", "ok": false,
        "error": ["code": "E_NO_ELEMENT", "message": "nothing at 1,2", "retryable": false, "detail": ["x": 1]],
      ])
  }

  func testFailureWithoutIdEncodesNull() {
    XCTAssertEqual(Response.failure(id: nil, error: WireError(.badRequest, "x")).json["id"], .null)
  }

  func testEventShapes() {
    XCTAssertEqual(
      Event.ready(["protocol": 1, "udid": "U"]).json, ["event": "ready", "protocol": 1, "udid": "U"])
    XCTAssertEqual(
      Event.log(level: .warn, message: "m", op: "snapshot", id: "3").json,
      ["event": "log", "level": "warn", "message": "m", "op": "snapshot", "id": "3"])
    XCTAssertEqual(
      Event.log(level: .info, message: "m", op: nil, id: nil).json, ["event": "log", "level": "info", "message": "m"])
    XCTAssertEqual(
      Event.fatal(WireError(.notBooted, "off")).json["error"]?["code"], "E_NOT_BOOTED")
  }

  // MARK: - Line buffer

  func testLineBufferSplitsAcrossChunks() {
    var buffer = LineBuffer()
    XCTAssertEqual(buffer.append(Data("{\"a\":".utf8)), [])
    let lines = buffer.append(Data("1}\n{\"b\":2}\n{\"c\"".utf8))
    XCTAssertEqual(lines.map { String(decoding: $0, as: UTF8.self) }, ["{\"a\":1}", "{\"b\":2}"])
    XCTAssertEqual(String(decoding: buffer.flush() ?? Data(), as: UTF8.self), "{\"c\"")
    XCTAssertNil(buffer.flush())
  }

  func testLineBufferAcceptsCRLFAndDropsBlankLines() {
    var buffer = LineBuffer()
    let lines = buffer.append(Data("\r\n{\"a\":1}\r\n\n  \n".utf8))
    XCTAssertEqual(lines.map { String(decoding: $0, as: UTF8.self) }, ["{\"a\":1}"])
  }

  func testLineBufferHandlesMultibyteSplit() {
    var buffer = LineBuffer()
    let bytes = Array("{\"t\":\"é\"}\n".utf8)
    XCTAssertEqual(buffer.append(Data(bytes[0..<7])), [])
    let lines = buffer.append(Data(bytes[7...]))
    XCTAssertEqual(lines.count, 1)
    XCTAssertEqual(try? JSONDecoder().decode(JSON.self, from: lines[0])["t"], "é")
  }
}
