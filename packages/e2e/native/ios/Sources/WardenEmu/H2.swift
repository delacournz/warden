import Foundation

/// The slice of HTTP/2 (cleartext, prior knowledge) one gRPC server-streaming call needs: frames, SETTINGS, PING
/// and WINDOW_UPDATE, and a request header block of HPACK literals. Response header blocks are never decoded: the
/// stream only needs DATA, and its end (END_STREAM, RST_STREAM, GOAWAY or a closed socket).
package enum H2 {
  package static let preface = Data("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".utf8)
  package static let headerLength = 9
  package static let maxWindow: UInt32 = 0x7FFF_FFFF
  package static let defaultWindow: UInt32 = 65_535

  package enum FrameType: UInt8 {
    case data = 0, headers = 1, rstStream = 3, settings = 4, ping = 6, goaway = 7, windowUpdate = 8, continuation = 9
  }

  package enum Flag {
    package static let endStream: UInt8 = 0x1
    package static let ack: UInt8 = 0x1
    package static let endHeaders: UInt8 = 0x4
    package static let padded: UInt8 = 0x8
    package static let priority: UInt8 = 0x20
  }

  package enum Setting: UInt16 {
    case enablePush = 2, initialWindowSize = 4
  }

  package struct Frame: Equatable, Sendable {
    package var type: UInt8
    package var flags: UInt8
    package var stream: UInt32
    package var payload: Data

    package init(type: UInt8, flags: UInt8, stream: UInt32, payload: Data) {
      self.type = type
      self.flags = flags
      self.stream = stream
      self.payload = payload
    }

    package var encoded: Data {
      var out = Data(capacity: H2.headerLength + payload.count)
      let length = UInt32(payload.count)
      out.append(contentsOf: [UInt8(length >> 16 & 0xFF), UInt8(length >> 8 & 0xFF), UInt8(length & 0xFF), type, flags])
      out.append(contentsOf: withUnsafeBytes(of: (stream & 0x7FFF_FFFF).bigEndian, Array.init))
      out.append(payload)
      return out
    }

    /// DATA without its padding (PADDED flag), nil when the padding is malformed.
    package var dataPayload: Data? {
      guard flags & Flag.padded != 0 else { return payload }
      guard let pad = payload.first, Int(pad) < payload.count else { return nil }
      return payload.subdata(in: payload.startIndex + 1..<payload.endIndex - Int(pad))
    }
  }

  package static func frame(_ type: FrameType, flags: UInt8 = 0, stream: UInt32 = 0, payload: Data = Data()) -> Data {
    Frame(type: type.rawValue, flags: flags, stream: stream, payload: payload).encoded
  }

  package static func settings(_ pairs: [(Setting, UInt32)]) -> Data {
    var payload = Data()
    for (id, value) in pairs {
      payload.append(contentsOf: withUnsafeBytes(of: id.rawValue.bigEndian, Array.init))
      payload.append(contentsOf: withUnsafeBytes(of: value.bigEndian, Array.init))
    }
    return frame(.settings, payload: payload)
  }

  package static func windowUpdate(stream: UInt32, increment: UInt32) -> Data {
    frame(.windowUpdate, stream: stream, payload: Data(withUnsafeBytes(of: (increment & 0x7FFF_FFFF).bigEndian, Array.init)))
  }

  /// HPACK integer (RFC 7541 5.1) with an `prefixBits`-bit prefix, OR-ed into `first`.
  package static func hpackInteger(_ value: Int, prefixBits: Int, first: UInt8 = 0) -> [UInt8] {
    let limit = (1 << prefixBits) - 1
    if value < limit { return [first | UInt8(value)] }
    var out: [UInt8] = [first | UInt8(limit)]
    var rest = value - limit
    while rest >= 128 {
      out.append(UInt8(rest % 128 + 128))
      rest /= 128
    }
    out.append(UInt8(rest))
    return out
  }

  /// Every header as "literal without indexing, new name", no Huffman: the encoder keeps no table state.
  package static func headerBlock(_ headers: [(String, String)]) -> Data {
    var out: [UInt8] = []
    for (name, value) in headers {
      out.append(0x00)
      out += hpackInteger(name.utf8.count, prefixBits: 7) + Array(name.utf8)
      out += hpackInteger(value.utf8.count, prefixBits: 7) + Array(value.utf8)
    }
    return Data(out)
  }

  /// Splits a byte stream into frames; bytes of an unfinished frame wait for the next push.
  package struct FrameReader {
    private var buffer = Data()

    package init() {}

    package mutating func push(_ chunk: Data) -> [Frame] {
      buffer.append(chunk)
      var frames: [Frame] = []
      var offset = buffer.startIndex
      while buffer.endIndex - offset >= H2.headerLength {
        let length = Int(buffer[offset]) << 16 | Int(buffer[offset + 1]) << 8 | Int(buffer[offset + 2])
        guard buffer.endIndex - offset >= H2.headerLength + length else { break }
        let stream =
          (UInt32(buffer[offset + 5]) << 24 | UInt32(buffer[offset + 6]) << 16 | UInt32(buffer[offset + 7]) << 8
            | UInt32(buffer[offset + 8])) & 0x7FFF_FFFF
        let start = offset + H2.headerLength
        frames.append(
          Frame(type: buffer[offset + 3], flags: buffer[offset + 4], stream: stream, payload: buffer.subdata(in: start..<start + length)))
        offset = start + length
      }
      buffer = buffer.subdata(in: offset..<buffer.endIndex)
      return frames
    }
  }
}

/// gRPC length-prefixed messages (`[u8 compressed][u32 length][message]`) out of DATA payloads.
package struct GrpcMessageReader {
  private var buffer = Data()
  /// A compressed message: never asked for, so the stream is broken.
  package private(set) var compressed = false

  package init() {}

  package static func frame(_ message: Data) -> Data {
    var out = Data([0])
    out.append(contentsOf: withUnsafeBytes(of: UInt32(message.count).bigEndian, Array.init))
    out.append(message)
    return out
  }

  package mutating func push(_ chunk: Data) -> [Data] {
    buffer.append(chunk)
    var messages: [Data] = []
    var offset = buffer.startIndex
    while buffer.endIndex - offset >= 5 {
      let length =
        Int(buffer[offset + 1]) << 24 | Int(buffer[offset + 2]) << 16 | Int(buffer[offset + 3]) << 8 | Int(buffer[offset + 4])
      guard buffer.endIndex - offset >= 5 + length else { break }
      if buffer[offset] != 0 { compressed = true }
      messages.append(buffer.subdata(in: offset + 5..<offset + 5 + length))
      offset += 5 + length
    }
    buffer = buffer.subdata(in: offset..<buffer.endIndex)
    return messages
  }
}
