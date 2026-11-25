import Foundation

/// The two protobuf messages `EmulatorController/streamScreenshot` needs (`emulator_controller.proto`, package
/// `android.emulation.control`), hand-encoded: one request, and the header fields of each reply. No protobuf runtime.
package enum Proto {
  package static func varint(_ value: UInt64) -> [UInt8] {
    var value = value
    var out: [UInt8] = []
    while value > 0x7F {
      out.append(UInt8(value & 0x7F) | 0x80)
      value >>= 7
    }
    out.append(UInt8(value))
    return out
  }

  /// A varint at `index` (advanced past it), nil when the bytes end inside it or it runs over 10 bytes.
  package static func readVarint(_ bytes: [UInt8], _ index: inout Int) -> UInt64? {
    var result: UInt64 = 0
    var shift: UInt64 = 0
    while index < bytes.count, shift < 70 {
      let byte = bytes[index]
      index += 1
      result |= UInt64(byte & 0x7F) << shift
      if byte < 0x80 { return result }
      shift += 7
    }
    return nil
  }

  static func varintField(_ number: UInt64, _ value: UInt64) -> [UInt8] {
    value == 0 ? [] : varint(number << 3) + varint(value)
  }

  static func bytesField(_ number: UInt64, _ bytes: [UInt8]) -> [UInt8] {
    varint(number << 3 | 2) + varint(UInt64(bytes.count)) + bytes
  }

  /// Visit each field of a message: `(number, varint value, length-delimited bytes)`. False on malformed input.
  static func fields(_ bytes: [UInt8], _ visit: (UInt64, UInt64?, [UInt8]?) -> Void) -> Bool {
    var index = 0
    while index < bytes.count {
      guard let key = readVarint(bytes, &index) else { return false }
      let number = key >> 3
      switch key & 7 {
      case 0:
        guard let value = readVarint(bytes, &index) else { return false }
        visit(number, value, nil)
      case 1:
        index += 8
      case 2:
        guard let length = readVarint(bytes, &index), length <= UInt64(bytes.count - index) else { return false }
        visit(number, nil, Array(bytes[index..<index + Int(length)]))
        index += Int(length)
      case 5:
        index += 4
      default:
        return false
      }
    }
    return index == bytes.count
  }
}

/// `ImageFormat{format: RGB888, width, height, transport: {channel: MMAP, handle: "file://<path>"}}`: the emulator
/// writes each frame's pixels into the file and the reply carries only its header, so a 60 fps stream is a few KB/s
/// of gRPC instead of ~120 MB/s.
package struct ScreenshotRequest: Equatable, Sendable {
  package var width: Int
  package var height: Int
  package var mmapPath: String

  package init(width: Int, height: Int, mmapPath: String) {
    self.width = width
    self.height = height
    self.mmapPath = mmapPath
  }

  /// `ImageFormat.ImgFormat.RGB888`
  static let rgb888: UInt64 = 2
  /// `ImageTransport.TransportChannel.MMAP`
  static let mmap: UInt64 = 1

  package var encoded: Data {
    let transport = Proto.varintField(1, Self.mmap) + Proto.bytesField(2, Array("file://\(mmapPath)".utf8))
    let message =
      Proto.varintField(1, Self.rgb888) + Proto.varintField(3, UInt64(width)) + Proto.varintField(4, UInt64(height))
      + Proto.bytesField(6, transport)
    return Data(message)
  }
}

/// The parts of an `Image` reply the stream uses: `format{width=3, height=4}` (field 1), `seq` (5),
/// `timestampUs` (6). Pixels are in the mmap file, so `image` (4) is empty.
package struct ImageHeader: Equatable, Sendable {
  package var width = 0
  package var height = 0
  package var seq: UInt64 = 0
  package var timestampUs: UInt64 = 0

  package init(width: Int = 0, height: Int = 0, seq: UInt64 = 0, timestampUs: UInt64 = 0) {
    self.width = width
    self.height = height
    self.seq = seq
    self.timestampUs = timestampUs
  }

  package static func decode(_ data: Data) -> ImageHeader? {
    var header = ImageHeader()
    var formatOK = true
    let ok = Proto.fields(Array(data)) { number, value, bytes in
      switch (number, value, bytes) {
      case let (1, _, format?):
        formatOK = Proto.fields(format) { inner, innerValue, _ in
          if inner == 3, let innerValue { header.width = Int(innerValue) }
          if inner == 4, let innerValue { header.height = Int(innerValue) }
        }
      case let (5, seq?, _): header.seq = seq
      case let (6, timestamp?, _): header.timestampUs = timestamp
      default: break
      }
    }
    return ok && formatOK ? header : nil
  }

  /// Test helper and fake-server encoder: the reply the emulator sends.
  package var encoded: Data {
    let format = Proto.varintField(1, ScreenshotRequest.rgb888) + Proto.varintField(3, UInt64(width))
      + Proto.varintField(4, UInt64(height))
    return Data(Proto.bytesField(1, format) + Proto.varintField(5, seq) + Proto.varintField(6, timestampUs))
  }
}
