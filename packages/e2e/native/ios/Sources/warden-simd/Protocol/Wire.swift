import Foundation

/// Build constants. `idb` must equal `native/idb.lock.json` `version` (`native/scripts/build.ts` enforces it).
enum BuildInfo {
  static let protocolVersion = 1
  static let version = "0.1.0"
  static let idb = "v1.7.7"
}

/// A JSON value. The wire format is NDJSON, so every request/response/event is one of these.
enum JSON: Sendable, Equatable {
  case null
  case bool(Bool)
  case int(Int)
  case double(Double)
  case string(String)
  case array([JSON])
  case object([String: JSON])

  var stringValue: String? {
    if case let .string(value) = self { return value }
    return nil
  }

  var intValue: Int? {
    switch self {
    case let .int(value): return value
    case let .double(value) where value.rounded() == value && abs(value) < 9e15: return Int(value)
    default: return nil
    }
  }

  var doubleValue: Double? {
    switch self {
    case let .int(value): return Double(value)
    case let .double(value): return value
    default: return nil
    }
  }

  var boolValue: Bool? {
    if case let .bool(value) = self { return value }
    return nil
  }

  var objectValue: [String: JSON]? {
    if case let .object(value) = self { return value }
    return nil
  }

  var arrayValue: [JSON]? {
    if case let .array(value) = self { return value }
    return nil
  }

  subscript(key: String) -> JSON? {
    objectValue?[key]
  }
}

extension JSON: Codable {
  init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Int.self) {
      self = .int(value)
    } else if let value = try? container.decode(Double.self) {
      self = .double(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSON].self) {
      self = .array(value)
    } else if let value = try? container.decode([String: JSON].self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "not a JSON value")
    }
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case let .bool(value): try container.encode(value)
    case let .int(value): try container.encode(value)
    case let .double(value): try container.encode(value)
    case let .string(value): try container.encode(value)
    case let .array(value): try container.encode(value)
    case let .object(value): try container.encode(value)
    }
  }
}

extension JSON: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
  ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
  init(nilLiteral: ()) { self = .null }
  init(booleanLiteral value: Bool) { self = .bool(value) }
  init(integerLiteral value: Int) { self = .int(value) }
  init(floatLiteral value: Double) { self = .double(value) }
  init(stringLiteral value: String) { self = .string(value) }
  init(arrayLiteral elements: JSON...) { self = .array(elements) }
  init(dictionaryLiteral elements: (String, JSON)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
  }
}

/// Wire error codes (plan WDN-E2E, `warden-simd` protocol v1). TS-side-only codes
/// (`E_HELPER_MISSING`, `E_HELPER_CRASHED`, `E_STALE_REF`) are never produced here.
enum ErrorCode: String, CaseIterable, Sendable {
  case badRequest = "E_BAD_REQUEST"
  case timeout = "E_TIMEOUT"
  case notBooted = "E_NOT_BOOTED"
  case unknownUdid = "E_UNKNOWN_UDID"
  case hid = "E_HID"
  case axUnavailable = "E_AX_UNAVAILABLE"
  case appUnavailable = "E_APP_UNAVAILABLE"
  case appNotResponding = "E_APP_NOT_RESPONDING"
  case noElement = "E_NO_ELEMENT"
  case unsupported = "E_UNSUPPORTED"
  case unsupportedText = "E_UNSUPPORTED_TEXT"
  case io = "E_IO"
  case `internal` = "E_INTERNAL"

  /// Mirrors the TS driver (`driver/errors.ts` RETRYABLE) for the codes both sides share.
  var retryableByDefault: Bool {
    switch self {
    case .timeout, .axUnavailable, .appNotResponding: return true
    default: return false
    }
  }
}

struct WireError: Error, Equatable, Sendable {
  let code: ErrorCode
  let message: String
  let retryable: Bool
  let detail: JSON?

  init(_ code: ErrorCode, _ message: String, retryable: Bool? = nil, detail: JSON? = nil) {
    self.code = code
    self.message = message
    self.retryable = retryable ?? code.retryableByDefault
    self.detail = detail
  }

  var json: JSON {
    var fields: [String: JSON] = [
      "code": .string(code.rawValue),
      "message": .string(message),
      "retryable": .bool(retryable),
    ]
    if let detail { fields["detail"] = detail }
    return .object(fields)
  }
}

/// One request line: `{"id","op",…,"timeoutMs"?}`. `params` is the whole object, so ops read their own fields.
struct Request: Equatable, Sendable {
  let id: String
  let op: String
  let timeoutMs: Int?
  let params: JSON
}

enum Response: Equatable, Sendable {
  case success(id: String?, data: JSON)
  case failure(id: String?, error: WireError)

  var json: JSON {
    switch self {
    case let .success(id, data):
      return .object(["id": id.map(JSON.string) ?? .null, "ok": .bool(true), "data": data])
    case let .failure(id, error):
      return .object(["id": id.map(JSON.string) ?? .null, "ok": .bool(false), "error": error.json])
    }
  }
}

enum LogLevel: String, Sendable {
  case debug
  case info
  case warn
  case error
}

/// Unsolicited lines. `ready` carries its fields flat next to `"event"`.
enum Event: Equatable, Sendable {
  case ready([String: JSON])
  case log(level: LogLevel, message: String, op: String?, id: String?)
  case fatal(WireError)

  var json: JSON {
    switch self {
    case let .ready(fields):
      var object = fields
      object["event"] = "ready"
      return .object(object)
    case let .log(level, message, op, id):
      var object: [String: JSON] = ["event": "log", "level": .string(level.rawValue), "message": .string(message)]
      if let op { object["op"] = .string(op) }
      if let id { object["id"] = .string(id) }
      return .object(object)
    case let .fatal(error):
      return .object(["event": "fatal", "error": error.json])
    }
  }
}
