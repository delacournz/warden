import FBControlCore
import FBSimulatorControl
import Foundation

enum ScreenshotOps {
  static let ops: [String: Dispatcher<Session>.OpHandler] = [
    "screenshot": { session, params in
      try await session.screenshot(ScreenshotRequest(params))
    }
  ]
}

/// `screenshot{scale?, path?}`. `scale` is a factor in (0, 1] of the native capture (default 1: `screen × screen scale`
/// pixels); `path` makes the helper write the PNG there instead of returning it base64.
struct ScreenshotRequest: Equatable {
  var scale: Double
  var path: String?

  init(_ params: JSON) throws {
    var scale = 1.0
    if let raw = params["scale"], raw != .null {
      guard let value = raw.doubleValue, value > 0, value <= 1 else {
        throw WireError(.badRequest, "\"scale\" must be a number in (0, 1]")
      }
      scale = value
    }
    var path: String?
    if let raw = params["path"], raw != .null {
      guard let value = raw.stringValue, !value.isEmpty else {
        throw WireError(.badRequest, "\"path\" must be a non-empty string")
      }
      path = value
    }
    self.scale = scale
    self.path = path
  }
}

extension Session {
  /// A framebuffer capture (not Simulator.app), PNG-encoded.
  func screenshot(_ request: ScreenshotRequest) async throws -> JSON {
    let configuration = ScreenshotConfiguration(
      encoding: .png, scale: request.scale < 1 ? .factor(request.scale) : .native)
    let result = try await simulator.screenshot.take(configuration: configuration)
    var fields: [String: JSON] = [
      "width": .int(Int(result.size.width.rounded())),
      "height": .int(Int(result.size.height.rounded())),
    ]
    if let path = request.path {
      do {
        try result.imageData.write(to: URL(fileURLWithPath: path), options: .atomic)
      } catch {
        throw WireError(.io, "could not write screenshot to \(path): \(error.localizedDescription)")
      }
      fields["path"] = .string(path)
    } else {
      fields["png"] = .string(result.imageData.base64EncodedString())
    }
    return .object(fields)
  }
}
