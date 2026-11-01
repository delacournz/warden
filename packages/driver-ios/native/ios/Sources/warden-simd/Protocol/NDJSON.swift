import Foundation

/// A request line that could not be turned into a `Request`. `id` is set when the line carried a usable one,
/// so the caller can still answer the right request.
struct RequestParseFailure: Error, Equatable, Sendable {
  let id: String?
  let error: WireError
}

enum NDJSON {
  private static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }()

  /// One compact JSON line, newline-terminated.
  static func encodeLine(_ json: JSON) -> Data {
    var data: Data
    do {
      data = try encoder.encode(json)
    } catch {
      // Only reachable for non-finite doubles; keep the stream well-formed rather than dropping the line.
      let fallback = Response.failure(id: nil, error: WireError(.internal, "unencodable value: \(error)"))
      data = (try? encoder.encode(fallback.json)) ?? Data("{}".utf8)
    }
    data.append(0x0A)
    return data
  }

  static func parseRequest(line: Data) -> Result<Request, RequestParseFailure> {
    let value: JSON
    do {
      value = try JSONDecoder().decode(JSON.self, from: line)
    } catch {
      return .failure(RequestParseFailure(id: nil, error: WireError(.badRequest, "invalid JSON: not a single JSON value")))
    }
    guard case let .object(fields) = value else {
      return .failure(RequestParseFailure(id: nil, error: WireError(.badRequest, "request must be a JSON object")))
    }
    guard let idValue = fields["id"] else {
      return .failure(RequestParseFailure(id: nil, error: WireError(.badRequest, "request has no \"id\"")))
    }
    guard let id = idValue.stringValue, !id.isEmpty else {
      return .failure(RequestParseFailure(id: nil, error: WireError(.badRequest, "\"id\" must be a non-empty string")))
    }
    guard let op = fields["op"]?.stringValue, !op.isEmpty else {
      return .failure(RequestParseFailure(id: id, error: WireError(.badRequest, "request has no \"op\" string")))
    }
    var timeoutMs: Int?
    if let raw = fields["timeoutMs"], raw != .null {
      guard let ms = raw.intValue, ms > 0 else {
        return .failure(RequestParseFailure(id: id, error: WireError(.badRequest, "\"timeoutMs\" must be a positive integer")))
      }
      timeoutMs = ms
    }
    return .success(Request(id: id, op: op, timeoutMs: timeoutMs, params: value))
  }
}

/// Splits a byte stream into lines. Chunks may end mid-line; `\r\n` is accepted; blank lines are dropped.
struct LineBuffer {
  private var pending = Data()

  mutating func append(_ chunk: Data) -> [Data] {
    pending.append(chunk)
    var lines: [Data] = []
    while let newline = pending.firstIndex(of: 0x0A) {
      let line = pending[pending.startIndex..<newline]
      pending = Data(pending[pending.index(after: newline)...])
      if let cleaned = Self.clean(Data(line)) { lines.append(cleaned) }
    }
    return lines
  }

  /// The unterminated tail at end of input (a final line with no newline), if any.
  mutating func flush() -> Data? {
    defer { pending = Data() }
    return Self.clean(pending)
  }

  private static func clean(_ line: Data) -> Data? {
    var trimmed = line
    while let last = trimmed.last, last == 0x0D || last == 0x20 || last == 0x09 { trimmed.removeLast() }
    return trimmed.isEmpty ? nil : trimmed
  }
}
