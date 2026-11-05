import Foundation

/// One encoded access unit as it leaves the encoder.
struct EncodedUnit: Sendable, Equatable {
  /// Annex-B: every NAL unit behind a 4-byte start code; keyframes lead with SPS and PPS.
  var data: Data
  var flags: AUFlags
  /// Capture time, microseconds since the stream started (monotonic).
  var ptsMicros: UInt64
}

struct AUFlags: OptionSet, Sendable, Equatable {
  let rawValue: UInt8
  /// An IDR: a receiver can start decoding here.
  static let key = AUFlags(rawValue: 1 << 0)
  /// The unit carries SPS/PPS.
  static let config = AUFlags(rawValue: 1 << 1)
}

/// The stream socket's framing: `[u32 length][u8 flags][u64 pts_us][length bytes of Annex-B]`, big-endian.
enum AUFraming {
  static let headerLength = 13
  static let startCode: [UInt8] = [0, 0, 0, 1]

  static func header(length: UInt32, flags: AUFlags, ptsMicros: UInt64) -> Data {
    var out = Data(capacity: headerLength)
    withUnsafeBytes(of: length.bigEndian) { out.append(contentsOf: $0) }
    out.append(flags.rawValue)
    withUnsafeBytes(of: ptsMicros.bigEndian) { out.append(contentsOf: $0) }
    return out
  }

  static func frame(_ unit: EncodedUnit) -> Data {
    var out = header(length: UInt32(unit.data.count), flags: unit.flags, ptsMicros: unit.ptsMicros)
    out.append(unit.data)
    return out
  }

  /// VideoToolbox's AVCC sample (4-byte big-endian NAL lengths) as Annex-B, with `parameterSets` (SPS, PPS) first.
  static func annexB(avcc: Data, parameterSets: [Data]) throws -> Data {
    var out = Data(capacity: avcc.count + parameterSets.reduce(0) { $0 + $1.count + 4 } + 16)
    for set in parameterSets {
      out.append(contentsOf: startCode)
      out.append(set)
    }
    let bytes = [UInt8](avcc)
    var offset = 0
    while offset < bytes.count {
      guard offset + 4 <= bytes.count else { throw WireError(.internal, "truncated AVCC length at \(offset)") }
      let length =
        Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
      offset += 4
      guard length > 0, offset + length <= bytes.count else {
        throw WireError(.internal, "AVCC NAL of \(length) bytes overruns the sample at \(offset)")
      }
      out.append(contentsOf: startCode)
      out.append(contentsOf: bytes[offset..<offset + length])
      offset += length
    }
    return out
  }

  /// The NAL units of an Annex-B buffer (3- or 4-byte start codes), without their start codes.
  static func nals(_ annexB: Data) -> [Data] {
    let bytes = [UInt8](annexB)
    var starts: [(code: Int, payload: Int)] = []
    var i = 0
    while i + 2 < bytes.count {
      if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 1 {
        let code = i > 0 && bytes[i - 1] == 0 ? i - 1 : i
        starts.append((code, i + 3))
        i += 3
      } else {
        i += 1
      }
    }
    return starts.enumerated().map { index, start in
      let end = index + 1 < starts.count ? starts[index + 1].code : bytes.count
      return Data(bytes[start.payload..<end])
    }
  }
}
